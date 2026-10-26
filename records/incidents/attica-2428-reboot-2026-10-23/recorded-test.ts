import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { startControlServer, type ControlHarness } from "./helpers/attica-control-harness.js";

type Page = {
  goto(url: string): Promise<unknown>;
  locator(selector: string): {
    click(): Promise<void>;
    count(): Promise<number>;
    dispatchEvent(type: string): Promise<void>;
    focus(): Promise<void>;
    textContent(): Promise<string | null>;
  };
  keyboard: {
    press(key: string): Promise<void>;
  };
  on(event: "request", listener: (request: { url(): string }) => void): void;
  route(url: string, handler: (route: {
    request(): { method(): string; url(): string };
    fulfill(options: { status: number; contentType: string; body: string }): Promise<void>;
  }) => Promise<void>): Promise<void>;
  waitForFunction(
    fn: () => boolean,
    arg: undefined,
    options: { timeout: number },
  ): Promise<unknown>;
  close(): Promise<void>;
};

type Browser = {
  newPage(): Promise<Page>;
  close(): Promise<void>;
};

type Chromium = {
  launch(options: { headless: boolean; executablePath: string }): Promise<Browser>;
};

function loadPlaywright(): { chromium: Chromium } {
  const localRequire = createRequire(__filename);
  return localRequire("../browser/node_modules/playwright") as { chromium: Chromium };
}

async function waitForPause(harness: ControlHarness): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (harness.getStore().loadPause().pauseType === "captcha") return;
    await harness.sleep(10);
  }
  throw new Error("CAPTCHA pause was not reached");
}

async function waitForResumeEnabled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const button = document.querySelector("#resume");
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 5000 });
}

test("built control button verifies CAPTCHA, preserves refusal, and suppresses duplicate activation", async () => {
  let harness: ControlHarness | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  const requests: string[] = [];
  let releaseVerification: (() => void) | undefined;

  try {
    const { chromium } = loadPlaywright();
    harness = await startControlServer({
      prefix: "attica-control-ui-",
      fakeSessionOptions: { detailMode: "captcha", completeListings: false },
    });
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    });
    page = await browser.newPage();
    page.on("request", (request) => {
    if (request.url().includes("/api/")) requests.push(new URL(request.url()).pathname);
  });

    if (!harness || !browser || !page) throw new Error("browser setup did not complete");
    const activePage = page;
    expect((await harness.httpRequest("POST", "/api/start", {
      target: harness.getFixtureOrigin() + "/page/1",
      maxPages: 1,
    })).status).toBe(202);
    await waitForPause(harness);
    await activePage.goto(harness.serverUrl);
    await waitForResumeEnabled(activePage);

    await activePage.locator("#resume").click();
    await expect.poll(() => activePage.locator("#explanation").textContent(), { timeout: 10000 }).toContain("CAPTCHA verification");
    const refusalStatus = await harness.httpRequest("GET", "/api/status");
    const refusalBody: unknown = JSON.parse(refusalStatus.body);
    expect(refusalStatus.status).toBe(200);
    expect(typeof refusalBody === "object" && refusalBody !== null && "pauseType" in refusalBody && refusalBody.pauseType === "captcha").toBe(true);
    expect(harness.getStore().loadPause().pauseType).toBe("captcha");
    expect(requests.slice(-2)).toEqual(["/api/status", "/api/verify-access"]);
    expect(requests).not.toContain("/api/resume");

    harness.getFakeSession()._setDetailMode("normal");
    const verificationPending = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    harness.getFakeSession()._setHoldContentOpen(verificationPending);
    requests.length = 0;
    await waitForResumeEnabled(activePage);
    await activePage.locator("#resume").click();
    await activePage.locator("#resume").dispatchEvent("click");
    await expect.poll(() => requests.filter((route) => route === "/api/verify-access").length, { timeout: 10000 }).toBe(1);
    expect(requests.filter((route) => route === "/api/resume")).toHaveLength(0);
    if (!releaseVerification) throw new Error("verification release was not prepared");
    releaseVerification();
    harness.getFakeSession()._clearHoldContent();
    await expect.poll(() => requests.filter((route) => route === "/api/resume").length, { timeout: 10000 }).toBe(1);
    expect(requests.filter((route) => route === "/api/verify-access")).toHaveLength(1);
    expect(requests.filter((route) => route === "/api/resume")).toHaveLength(1);
    expect(requests.indexOf("/api/verify-access")).toBeLessThan(requests.indexOf("/api/resume"));
  } finally {
    if (releaseVerification) releaseVerification();
    harness?.getFakeSession()._clearHoldContent();
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await harness?.cleanup();
  }
}, 30000);

test("browser startup failure still cleans the owned harness", async () => {
  let harness: ControlHarness | undefined;
  try {
    const { chromium } = loadPlaywright();
    harness = await startControlServer({
      prefix: "attica-control-ui-startup-failure-",
      fakeSessionOptions: { detailMode: "captcha", completeListings: false },
    });
    await expect(chromium.launch({
      headless: true,
      executablePath: "/definitely-not-a-browser",
    })).rejects.toThrow();
  } finally {
    await harness?.cleanup();
  }
});

test("built control button resumes an ordinary pause without verification via Enter", async () => {
  let harness: ControlHarness | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  const requests: string[] = [];

  try {
    const { chromium } = loadPlaywright();
    harness = await startControlServer({
      prefix: "attica-control-ui-ordinary-",
      fakeSessionOptions: { result429Count: 1, retryAfterMode: "seconds:1" },
    });
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    });
    page = await browser.newPage();
    page.on("request", (request) => {
    if (request.url().includes("/api/")) requests.push(new URL(request.url()).pathname);
  });

    expect((await harness.httpRequest("POST", "/api/start", {
      target: harness.getFixtureOrigin() + "/page/1",
      maxPages: 1,
    })).status).toBe(202);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (harness.getStore().loadPause().pauseType === "rate-limit") break;
      await harness.sleep(10);
    }
    harness.advanceClock(2000);
    await page.goto(harness.serverUrl);
    await waitForResumeEnabled(page);
    await page.locator("#resume").focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => requests.includes("/api/resume"), { timeout: 10000 }).toBe(true);
    expect(requests).toContain("/api/resume");
    expect(requests).not.toContain("/api/verify-access");
  } finally {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await harness?.cleanup();
  }
});


test("offline failed action keeps its error while refreshed status and rows advance", async () => {
  let harness: ControlHarness | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let releaseInitialStatus: (() => void) | undefined;

  try {
    const { chromium } = loadPlaywright();
    harness = await startControlServer({ prefix: "attica-control-ui-refresh-error-" });
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    });
    page = await browser.newPage();
    const initialStatus = new Promise<void>((resolve) => {
      releaseInitialStatus = resolve;
    });
    let statusRequests = 0;
    let initialStatusFulfilled = false;
    await page.route("**/api/*", async (route) => {
      const request = route.request();
      if (request.url().endsWith("/api/status") && request.method() === "GET") {
        statusRequests += 1;
        if (statusRequests === 1) await initialStatus;
        const state = statusRequests === 1
          ? { status: "idle", label: "Ancien état", reason: "ancienne réponse", rows: [{ identifiant: "old" }] }
          : { status: "idle", label: "État actualisé", reason: "données fraîches", rows: [{ identifiant: "new" }, { identifiant: "newer" }] };
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state) });
        if (statusRequests === 1) initialStatusFulfilled = true;
        return;
      }
      if (request.url().endsWith("/api/cancel") && request.method() === "POST") {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Arrêt refusé hors ligne" }) });
        return;
      }
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "fixture endpoint absent" }) });
    });
    await page.goto(harness.serverUrl);
    await page.locator("#cancel").click();
    await expect.poll(() => page?.locator("#explanation").textContent(), { timeout: 5000 }).toContain("Arrêt refusé hors ligne");
    if (!releaseInitialStatus) throw new Error("initial status release was not prepared");
    releaseInitialStatus();
    await expect.poll(() => initialStatusFulfilled, { timeout: 5000 }).toBe(true);
    await expect.poll(() => page?.locator("#state").textContent(), { timeout: 250 }).not.toContain("Ancien état");
    await expect.poll(() => page?.locator("#announcements").textContent(), { timeout: 250 }).not.toContain("old");
    await expect.poll(() => page?.locator("#state").textContent(), { timeout: 5000 }).toContain("État actualisé");
    await expect.poll(() => page?.locator("#announcements").textContent(), { timeout: 5000 }).toContain("newer");
    expect(await page.locator("#explanation").textContent()).toContain("Arrêt refusé hors ligne");
    expect(await page.locator("#announcements .listing").count()).toBe(2);
  } finally {
    if (releaseInitialStatus) releaseInitialStatus();
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await harness?.cleanup();
  }
});
