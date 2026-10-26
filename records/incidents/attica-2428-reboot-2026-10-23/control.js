"use strict";
function element(id) {
    const value = document.getElementById(id);
    if (!value)
        throw new Error("missing control: " + id);
    return value;
}
function input(id) {
    const value = element(id);
    if (!(value instanceof HTMLInputElement))
        throw new Error("not an input: " + id);
    return value;
}
function text(id, value) {
    element(id).textContent = value;
}
async function api(endpoint, body, timeoutMs = 5000) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(endpoint, body === undefined ? {
            signal: controller.signal,
        } : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        const value = await response.json().catch(() => ({ error: "Réponse serveur invalide" }));
        if (!response.ok) {
            const error = typeof value === "object" && value !== null && "error" in value
                ? String(value.error)
                : "Requête refusée";
            throw new Error(error);
        }
        if (typeof value !== "object" || value === null || Array.isArray(value))
            throw new Error("Réponse invalide");
        return value;
    }
    finally {
        window.clearTimeout(timeout);
    }
}
function listingValue(row, ...keys) {
    for (const key of keys) {
        const value = row[key];
        if (value !== undefined && value !== null && String(value).trim())
            return String(value);
    }
    return "Non renseigné";
}
function listingIdentity(row, index) {
    return listingValue(row, "_storeKey", "identifiant", "xeId", "xe_id", "id", "canonicalUrl", "canonical_url", "url") === "Non renseigné"
        ? "row-" + String(index)
        : listingValue(row, "_storeKey", "identifiant", "xeId", "xe_id", "id", "canonicalUrl", "canonical_url", "url");
}
function safeHttpUrl(value) {
    if (typeof value !== "string")
        return null;
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    }
    catch {
        return null;
    }
}
function listingSource(row) {
    for (const key of ["url", "canonicalUrl", "canonical_url"]) {
        const href = safeHttpUrl(row[key]);
        if (href)
            return href;
    }
    return null;
}
const listingCards = new Map();
function renderListings(rows) {
    const container = element("announcements");
    const seen = new Set();
    rows.forEach((value, index) => {
        if (typeof value !== "object" || value === null || Array.isArray(value))
            return;
        const row = value;
        const key = listingIdentity(row, index);
        seen.add(key);
        let card = listingCards.get(key);
        if (!card) {
            card = document.createElement("article");
            card.className = "listing";
            card.dataset.listingKey = key;
            const title = document.createElement("h3");
            const facts = document.createElement("p");
            facts.className = "facts";
            const description = document.createElement("p");
            description.className = "description";
            const source = document.createElement("p");
            card.append(title, facts, description, source);
            listingCards.set(key, card);
            container.append(card);
        }
        const title = card.querySelector("h3");
        if (title) {
            title.textContent = listingValue(row, "type_de_bien", "title") + " · Identifiant : "
                + listingValue(row, "identifiant", "xeId", "xe_id", "id", "_storeKey");
        }
        const facts = card.querySelector(".facts");
        if (facts) {
            facts.textContent = "Prix : " + listingValue(row, "prix", "price") + " " + listingValue(row, "devise", "currency")
                + " · Surface : " + listingValue(row, "surface", "area", "size_with_square_meter")
                + " · Localisation : " + listingValue(row, "localisation", "location");
        }
        const description = card.querySelector(".description");
        if (description)
            description.textContent = "Description : " + listingValue(row, "description");
        const source = card.querySelector("p:last-child");
        if (source) {
            const sourceFocused = document.activeElement === source.querySelector("a");
            source.replaceChildren();
            const href = listingSource(row);
            if (href) {
                const link = document.createElement("a");
                link.href = href;
                link.textContent = "Voir la source";
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                source.append("Source : ", link);
                if (sourceFocused)
                    link.focus();
            }
            else {
                source.textContent = "Source : Non renseignée";
            }
        }
    });
    for (const [key, card] of listingCards) {
        if (!seen.has(key)) {
            card.remove();
            listingCards.delete(key);
        }
    }
    element("announcementEmpty").hidden = rows.length > 0;
}
function show(state) {
    text("state", String(state.label ?? state.status ?? "En attente"));
    text("explanation", String(state.reason ?? "Prêt."));
    const captcha = state.pauseType === "captcha" || (state.status === "paused" && /human verification|captcha|challenge/i.test(String(state.reason ?? "")));
    element("captchaNotice").hidden = !captcha;
    const browserLink = element("browserLink");
    browserLink.hidden = !captcha;
    if (captcha && typeof state.browserUrl === "string")
        browserLink.setAttribute("href", state.browserUrl);
    const resume = element("resume");
    const paused = state.status === "paused" || (typeof state.pauseType === "string" && state.pauseType.length > 0);
    if (resume instanceof HTMLButtonElement)
        resume.disabled = !paused;
    const rows = Array.isArray(state.rows) ? state.rows : [];
    renderListings(rows);
    text("listingCount", String(rows.length));
    text("counts", "Annonces : " + rows.length);
}
function bind() {
    let resumeInFlight = false;
    let viewVersion = 0;
    let protectedErrorVersion = -1;
    let protectedActionError;
    let refreshInFlight = false;
    let refreshRequested = false;
    const showRefreshedState = (state) => {
        show(state);
        if (protectedErrorVersion === viewVersion && protectedActionError !== undefined) {
            text("explanation", protectedActionError);
        }
    };
    const refresh = async () => {
        if (refreshInFlight) {
            refreshRequested = true;
            return;
        }
        refreshInFlight = true;
        const requestVersion = viewVersion;
        try {
            const state = await api("/api/status");
            if (requestVersion === viewVersion && !resumeInFlight) {
                showRefreshedState(state);
            }
        }
        catch (error) {
            if (requestVersion === viewVersion && !resumeInFlight && protectedErrorVersion !== viewVersion) {
                text("state", "Erreur serveur");
                text("explanation", error instanceof Error ? error.message : String(error));
            }
        }
        finally {
            refreshInFlight = false;
            if (refreshRequested) {
                refreshRequested = false;
                void refresh();
            }
        }
    };
    const showAnnouncements = (visible) => {
        element("announcementsPanel").hidden = !visible;
        element("collectePanel").hidden = visible;
        element("announcementsBottom").hidden = visible;
        element("navAnnouncements").setAttribute("aria-current", String(visible));
        element("navCollecte").setAttribute("aria-current", String(!visible));
    };
    element("navAnnouncements").addEventListener("click", () => showAnnouncements(true));
    element("navCollecte").addEventListener("click", () => showAnnouncements(false));
    element("tabConfiguration").addEventListener("click", () => {
        element("configurationPanel").hidden = false;
        element("suiviPanel").hidden = true;
    });
    element("tabSuivi").addEventListener("click", () => {
        element("configurationPanel").hidden = true;
        element("suiviPanel").hidden = false;
    });
    element("startForm").addEventListener("submit", (event) => {
        event.preventDefault();
        const actionVersion = ++viewVersion;
        void api("/api/start", {
            target: input("target").value.trim() || undefined,
            maxPages: Number(input("maxPages").value),
        }).then((state) => {
            if (actionVersion === viewVersion) {
                viewVersion += 1;
                protectedErrorVersion = -1;
                protectedActionError = undefined;
                show(state);
            }
        }).catch((error) => {
            if (actionVersion === viewVersion) {
                protectedErrorVersion = actionVersion;
                protectedActionError = error instanceof Error ? error.message : String(error);
                text("explanation", protectedActionError);
            }
        });
    });
    element("cancel").addEventListener("click", () => {
        const actionVersion = ++viewVersion;
        void api("/api/cancel", {}).then((state) => {
            if (actionVersion === viewVersion) {
                viewVersion += 1;
                protectedErrorVersion = -1;
                protectedActionError = undefined;
                show(state);
            }
        }).catch((error) => {
            if (actionVersion === viewVersion) {
                protectedErrorVersion = actionVersion;
                protectedActionError = error instanceof Error ? error.message : String(error);
                text("explanation", protectedActionError);
            }
        });
    });
    element("resume").addEventListener("click", () => {
        if (resumeInFlight)
            return;
        const resume = element("resume");
        if (!(resume instanceof HTMLButtonElement) || resume.disabled)
            return;
        resumeInFlight = true;
        resume.disabled = true;
        const actionVersion = ++viewVersion;
        const statePromise = api("/api/status").then((state) => {
            const captcha = state.pauseType === "captcha" || (state.status === "paused" && /human verification|captcha|challenge/i.test(String(state.reason ?? "")));
            return (captcha ? api("/api/verify-access", {}) : Promise.resolve(state)).then(() => api("/api/resume", {}));
        });
        void statePromise.then((state) => {
            if (actionVersion === viewVersion) {
                viewVersion += 1;
                protectedErrorVersion = -1;
                protectedActionError = undefined;
                show(state);
            }
        }).catch((error) => {
            if (actionVersion === viewVersion) {
                protectedErrorVersion = actionVersion;
                protectedActionError = error instanceof Error ? error.message : String(error);
                text("explanation", protectedActionError);
            }
            resume.disabled = false;
        }).finally(() => {
            resumeInFlight = false;
        });
    });
    element("scheduleForm").addEventListener("submit", (event) => {
        event.preventDefault();
        void api("/api/schedule", {
            enabled: input("scheduleEnabled").checked,
            time: input("scheduleTime").value,
            timezone: input("scheduleTimezone").value,
        }).then((value) => text("scheduleState", value.enabled ? "Planification activée." : "Planification désactivée."))
            .catch((error) => text("scheduleState", error instanceof Error ? error.message : String(error)));
    });
    void refresh();
    window.setInterval(() => {
        void refresh();
    }, 1000);
}
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
}
else {
    bind();
}
//# sourceMappingURL=control.js.map