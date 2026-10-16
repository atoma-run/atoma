/**
 * THE OPERATOR'S LEGAL PAGES: `/privacy`, `/terms` and `/support`.
 * ================================================================
 *
 * Static, server-rendered and scriptless. They describe ONE deployment —
 * atoma.run and the person who operates it — so they are served only where
 * the public origin is that deployment's (`servesLegalPages`). A self-hosted
 * instance runs the same AGPL code and must publish its own operator, never
 * this one, so it answers 404 here.
 *
 * The text is English only, like the showcase. Every number it states about
 * retention is passed in from the code that applies it (`LegalFacts`), and the
 * contact and address are the ones the repository's service terms already
 * publish (`docs/platform-commons-terms.md`); a test pins both, so the page
 * and the terms cannot name two different operators.
 */

/** The deployment these pages belong to. */
export const LEGAL_ORIGIN = 'https://atoma.run';
export const LEGAL_OPERATOR_NAME = 'Matthieu Foillard';
export const LEGAL_OPERATOR_ADDRESS = 'Pavlou Mela, 1, 15233 Athens, Greece';
export const LEGAL_CONTACT_EMAIL = 'mgf@iotanet.net';
/** The date the texts below last changed. */
export const LEGAL_UPDATED = '2026-10-16';

export const LEGAL_PATHS = ['/privacy', '/terms', '/support'] as const;
export type LegalPath = (typeof LEGAL_PATHS)[number];

export function isLegalPath(pathname: string): pathname is LegalPath {
  return (LEGAL_PATHS as readonly string[]).includes(pathname);
}

export function servesLegalPages(publicOrigin: URL): boolean {
  return publicOrigin.origin === LEGAL_ORIGIN;
}

/** Retention the code applies on this host, stated rather than restated. */
export interface LegalFacts {
  readonly runRetentionDays: number;
  readonly journalRetentionDays: number;
  readonly sessionDays: number;
}

/** No script, no network, no frames, no forms. */
export const LEGAL_SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

/** The footer links other public pages carry. */
export function legalLinks(): string {
  return '<a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/support">Support</a>';
}

const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#070b13;color:#e6edf7;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.6}
a{color:#9cc4ff}a:hover{color:#d1f5ff}
header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;max-width:820px;margin:0 auto;padding:20px 24px}
.brand{display:flex;align-items:center;gap:10px;color:#f8fbff;font-weight:800;font-size:22px;letter-spacing:-.04em;text-decoration:none}
.brand img{width:32px;height:32px}
nav{display:flex;gap:4px;flex-wrap:wrap}
nav a{color:#c9d4e6;text-decoration:none;font-size:15px;padding:10px 12px;min-height:44px;display:inline-flex;align-items:center}
nav a[aria-current=page]{color:#f8fbff;font-weight:700}
main{max-width:820px;margin:0 auto;padding:16px 24px 72px}
h1{font-size:clamp(32px,5vw,44px);line-height:1.1;letter-spacing:-.03em;color:#f8fbff;margin:16px 0 8px}
.updated{color:#8a99b4;font-size:14px;margin:0 0 28px}
h2{font-size:22px;letter-spacing:-.01em;color:#f8fbff;margin:40px 0 10px;padding-top:8px;border-top:1px solid #142238}
h3{font-size:17px;color:#f8fbff;margin:24px 0 6px}
p,li{color:#c9d4e6}
ul{padding-left:22px}li{margin:6px 0}
.lead{font-size:18px;color:#b9c5da}
.box{border:1px solid #2b4668;border-radius:16px;background:#0f1b2e;padding:20px 22px;margin:20px 0}
.box p{margin:6px 0}
table{width:100%;border-collapse:collapse;margin:12px 0;font-size:15px}
th,td{text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid #1f3350;color:#c9d4e6}
th{color:#f8fbff;font-weight:650}
.table{overflow-x:auto}
code{font:14px ui-monospace,SFMono-Regular,Menlo,monospace;background:#0f1b2e;border-radius:6px;padding:1px 6px;overflow-wrap:anywhere}
footer{max-width:820px;margin:0 auto;padding:24px;border-top:1px solid #142238;color:#8a99b4;font-size:14px;text-align:center}
@media (max-width:640px){header{padding:12px 16px}main{padding:8px 16px 56px}nav a{padding:10px 8px;font-size:14px}}
`;

const TITLES: Record<LegalPath, { readonly title: string; readonly description: string }> = {
  '/privacy': {
    title: 'Privacy policy',
    description: 'What personal data the hosted Atoma service at atoma.run processes, why, who receives it, how long it is kept, and your rights.',
  },
  '/terms': {
    title: 'Terms of service',
    description: 'The terms for using the hosted Atoma service at atoma.run, including its shared-learning commons.',
  },
  '/support': {
    title: 'Support',
    description: 'How to get help with the hosted Atoma service, its MCP server and its plugins for Claude and Codex.',
  },
};

function page(path: LegalPath, origin: URL, body: string): string {
  const { title, description } = TITLES[path];
  const canonical = new URL(path, origin).href;
  const nav = LEGAL_PATHS.map((link) =>
    `<a href="${link}"${link === path ? ' aria-current="page"' : ''}>${TITLES[link].title.replace(' policy', '').replace(' of service', '')}</a>`
  ).join('');
  // `canonical` is a serialised URL: quotes and angle brackets are
  // percent-encoded, so it is attribute-safe without escaping.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Atoma</title>
<meta name="description" content="${description}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Atoma">
<meta property="og:title" content="${title} — Atoma">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonical}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${CSS}</style>
</head>
<body>
<header><a class="brand" href="/"><img src="/favicon.svg" alt="" width="32" height="32"><span>Atoma</span></a>
<nav aria-label="Legal">${nav}<a href="/app">Sign in</a></nav></header>
<main>
<h1>${title}</h1>
<p class="updated">Last updated ${LEGAL_UPDATED}</p>
${body}
</main>
<footer>atoma.run · operated by ${LEGAL_OPERATOR_NAME}, Athens, Greece · ${legalLinks()}</footer>
</body>
</html>
`;
}

export function renderLegalPage(path: LegalPath, origin: URL, facts: LegalFacts): string {
  switch (path) {
    case '/privacy': return page(path, origin, privacyBody(facts));
    case '/terms': return page(path, origin, termsBody(facts));
    case '/support': return page(path, origin, supportBody());
  }
}

const mail = `<a href="mailto:${LEGAL_CONTACT_EMAIL}">${LEGAL_CONTACT_EMAIL}</a>`;

function privacyBody(facts: LegalFacts): string {
  return `<p class="lead">This policy explains what personal data the hosted Atoma service at atoma.run processes, why, who receives it, how long it is kept, and the rights you have over it. It applies to the website, the web app, the MCP server at <code>https://atoma.run/mcp</code> and the Atoma plugins for Claude and Codex, which connect to that server.</p>

<div class="box">
<p><strong>In short.</strong> We keep what is needed to sign you in and to run the work you ask for. We use no advertising, no analytics and no tracking cookies, and we do not sell or rent personal data. The content of your requests is sent to the AI model providers that carry out the work. What a run learns can be reused by other users' runs (see <a href="#commons">shared learning</a>), so do not put confidential, personal or sensitive data in your requests or files.</p>
</div>

<h2 id="controller">Who is responsible</h2>
<p>The controller of your personal data is ${LEGAL_OPERATOR_NAME}, a sole proprietor established in Greece, ${LEGAL_OPERATOR_ADDRESS} ("we", "us"). For any privacy question or request, write to ${mail}. We have not appointed a data protection officer.</p>
<p>Atoma is also open-source software. This policy covers only the service we operate at atoma.run, not instances that other people run with the same code.</p>

<h2 id="data">What we collect</h2>
<h3>Your account</h3>
<ul>
<li><strong>Sign-in identity.</strong> When you sign in with GitHub, Google or ChatGPT, we receive and store the provider's identifier for your account, your email address and whether the provider verified it, your display name and your profile picture. We fetch the picture once and serve it from atoma.run, so your browser does not contact the provider to show it. For GitHub we request no extra permission scope.</li>
<li><strong>Organisations and roles.</strong> The organisations you belong to, your role in each (owner, admin, member or viewer), invitations you create or accept, and your organisation's plan.</li>
<li><strong>Access credentials.</strong> Sessions, API tokens for the MCP server, and the authorisations you grant to MCP clients such as Claude or Codex. We store only hashes of session tokens, API tokens and refresh tokens, never the tokens themselves.</li>
</ul>
<h3>Your work</h3>
<ul>
<li><strong>Projects and runs.</strong> The goals and acceptance criteria you write, the files and repositories you give a project, project context and decisions, the project conversation, answers you give to questions a run asks, and what each run produces: its trace (the record of each step, including model prompts and responses), its log, its workspace and its delivered files, along with run metadata such as duration, cost and outcome.</li>
<li><strong>Connections you add.</strong> If you connect a GitHub account or GitHub App installation, an organisation's model-provider API key, your organisation's own MCP servers, or a personal Claude or ChatGPT subscription, we store what is needed to use it. GitHub tokens, provider API keys and MCP connection secrets are encrypted at rest (AES-256-GCM). A personal subscription's login is held in a private, access-restricted file on the server.</li>
<li><strong>Notifications.</strong> If you allow browser notifications, we store your browser's push subscription (an endpoint address and its encryption keys) and your language.</li>
</ul>
<h3>Technical data</h3>
<ul>
<li><strong>Audit journal.</strong> We record security and administrative events, such as sign-ins, organisation changes, token creation and revocation, and administrator access, with the account and organisation involved. The journal never contains tokens or the text of your work.</li>
<li><strong>IP addresses.</strong> The application uses your IP address only in memory to limit repeated sign-in and authorisation attempts, and does not store it. Our web server keeps standard access logs, which include IP addresses and browser user agents, for security and troubleshooting.</li>
</ul>

<h2 id="purposes">Why we use it, and on what legal basis</h2>
<div class="table"><table>
<tr><th>Purpose</th><th>Legal basis (GDPR)</th></tr>
<tr><td>Creating and securing your account, signing you in, and managing organisations, roles and invitations</td><td>Performance of our contract with you (Art. 6(1)(b))</td></tr>
<tr><td>Running the work you request, delivering the results, previewing them and, when you accept, publishing them to GitHub</td><td>Performance of our contract (Art. 6(1)(b))</td></tr>
<tr><td>Shared learning: extracting reusable recipes and trust history from runs, for every user's later runs</td><td>Performance of our contract, since shared learning is part of the service (Art. 6(1)(b)), and our legitimate interest in improving it (Art. 6(1)(f))</td></tr>
<tr><td>Reviewing finished runs, including with an AI model, to find and fix defects in Atoma</td><td>Our legitimate interest in a reliable service (Art. 6(1)(f))</td></tr>
<tr><td>Security: rate limits, the audit journal, server logs and abuse prevention</td><td>Our legitimate interest in protecting the service and its users (Art. 6(1)(f))</td></tr>
<tr><td>Browser notifications</td><td>Your consent, given through your browser's permission prompt (Art. 6(1)(a)), which you can withdraw at any time in your browser</td></tr>
<tr><td>Answering your requests and meeting legal obligations</td><td>Legal obligation (Art. 6(1)(c)) and legitimate interest (Art. 6(1)(f))</td></tr>
</table></div>
<p>We do not make decisions about you that produce legal or similarly significant effects based solely on automated processing. Automated decisions inside a run, such as choosing which agent takes a step, concern the work, not you.</p>

<h2 id="recipients">Who receives your data</h2>
<ul>
<li><strong>AI model providers.</strong> Requests, files and intermediate work are sent to the model providers that carry out each run, according to the models configured for your organisation or by us. These may include Anthropic, OpenAI, Google, xAI, Meta, Mistral, Alibaba Cloud (Qwen), DeepSeek, Moonshot AI and Zhipu AI (Z.ai). When you connect your own API key or subscription, that provider processes your requests under its own terms with you.</li>
<li><strong>TypeSafe.</strong> Every run uses TypeSafe's Decision model (<a href="https://typesafe.ai">typesafe.ai</a>) for bounded decisions, such as which agent or recipe takes a step and whether a plan or result can be approved without a model review. For each decision we send its content: the step's task text and constraints, descriptions of the candidates, and the plan or result under review with excerpts of its evidence. TypeSafe processes it under its own terms and may retain it.</li>
<li><strong>GitHub.</strong> If you sign in with GitHub, connect a GitHub App installation or publish a result, GitHub receives what that requires, including the delivered files and a commit message that contains the run's goal.</li>
<li><strong>Your organisation's own MCP servers</strong>, if your organisation connects them, receive the requests that runs make to them.</li>
<li><strong>Hosting and infrastructure.</strong> The service runs on a server rented from Hetzner Online GmbH in Germany. Let's Encrypt issues our TLS certificates, and Gandi provides our domain names. They do not receive the content of your work, except that Hetzner hosts the server that stores it.</li>
<li><strong>Browser push services.</strong> Notifications travel through the push service your browser vendor operates (for example Google, Mozilla or Apple). The content is encrypted end to end and limited to a short status, an excerpt and a link.</li>
<li><strong>Map tiles.</strong> When you open a geographic data file in the file viewer, your browser loads map tiles from OpenStreetMap's tile servers, which then see your IP address.</li>
<li><strong>Other users.</strong> Members of your organisation see its projects and runs. Platform administrators can read across organisations for operation and support. These reads are recorded in the audit journal, and organisation owners are notified. Platform administrators do not read other users' project conversations.</li>
<li><strong>Authorities</strong>, where the law requires it.</li>
</ul>
<p>We use no email provider. Invitations are links that you pass on yourself.</p>

<h2 id="transfers">Transfers outside the European Economic Area</h2>
<p>Our server is in the EU. Several of the recipients above, including most AI model providers, GitHub and TypeSafe, process data outside the European Economic Area, including in the United States and, for some model providers, in China or Singapore. Where such a transfer takes place, it relies on an adequacy decision (such as the EU–U.S. Data Privacy Framework, where the recipient is certified) or on the standard contractual clauses or other safeguards that the recipient provides under Article 46 GDPR. Write to us for more information about the safeguards for a given recipient.</p>

<h2 id="commons">Shared learning</h2>
<p>Atoma is a shared-learning service. Every run can use the platform's catalogue of agents, learned recipes and trust history, and what a run learns can update them for later runs, including other organisations' runs. Learned recipes can contain code and wording derived from the work that produced them, and there is no individual approval step before they are reused. Your projects, workspaces, traces and files stay within your organisation. A recipe, however, can carry details of the work it came from, and removing a run's data does not automatically withdraw what was learned from it. This is why you should not submit personal, confidential or sensitive data. The <a href="/terms#commons">terms of service</a> describe shared learning in full.</p>

<h2 id="retention">How long we keep it</h2>
<ul>
<li><strong>Account, organisation and project data</strong>, including project conversations and context, are kept while your account or organisation exists, and deleted on request (see <a href="#rights">your rights</a>).</li>
<li><strong>Run traces, logs and workspaces</strong> become eligible for deletion ${facts.runRetentionDays} days after the run ends. We keep them longer while they are still needed: the latest run a project builds on, a result you accepted, or a publication or continuation that is not finished. Run records and their summary metadata are kept for as long as the project exists.</li>
<li><strong>Sessions</strong> expire after ${facts.sessionDays} days. MCP access tokens expire after one hour, and an MCP client's authorisation lasts at most 30 days before it must sign in again.</li>
<li><strong>The audit journal</strong> keeps events for ${facts.journalRetentionDays} days.</li>
<li><strong>Backups</strong> of the service are rotated, so deleted data disappears from them as older snapshots are replaced.</li>
<li>Data that TypeSafe or a model provider receives is kept according to that provider's own policy.</li>
</ul>

<h2 id="rights">Your rights</h2>
<p>Under the GDPR you have the right to access your personal data, to have it corrected or erased, to restrict or object to its processing, to receive it in a portable format, and to withdraw any consent you gave, without affecting processing that took place before. Some of this is self-service: you can change your display name, revoke API tokens and MCP authorisations, disconnect personal subscriptions, remove provider keys and MCP connections, and turn off notifications. For anything else, including deleting your account, an organisation or a project, write to ${mail} from the address linked to your account. We answer within one month.</p>
<p>You can also lodge a complaint with a supervisory authority, in particular the Hellenic Data Protection Authority (<a href="https://www.dpa.gr">dpa.gr</a>) or the authority where you live or work.</p>

<h2 id="cookies">Cookies and browser storage</h2>
<p>We use only cookies that are strictly necessary for the service. All of them are first-party and secure, and scripts cannot read them.</p>
<div class="table"><table>
<tr><th>Cookie</th><th>Purpose</th><th>Lifetime</th></tr>
<tr><td><code>__Host-atoma_session</code></td><td>Keeps you signed in</td><td>${facts.sessionDays} days</td></tr>
<tr><td><code>__Host-atoma_oauth_tx</code></td><td>Protects the sign-in exchange with your provider</td><td>10 minutes</td></tr>
<tr><td><code>__Host-atoma_mcp_return</code></td><td>Returns you to an MCP client's authorisation after sign-in</td><td>5 minutes</td></tr>
<tr><td><code>__Host-AtomaPreview</code></td><td>Lets you open the preview of a run's result</td><td>Until you close the browser</td></tr>
<tr><td><code>__Host-AtomaHosted</code></td><td>Lets you open an application that Atoma hosts for your project</td><td>5 minutes, renewed while you use it</td></tr>
</table></div>
<p>The web app also stores preferences in your browser (language, theme, the assistant model you chose, whether you dismissed a notification prompt) and keeps an offline copy of the app shell. These never leave your device.</p>

<h2 id="security">Security</h2>
<p>Traffic is encrypted with TLS. Organisations are isolated from one another, credentials are encrypted or hashed as described above, and model-written code runs in isolated containers. Atoma is under active development and has not been independently audited, so we cannot guarantee that no defect exists. Please report vulnerabilities as described on the <a href="/support#security">support page</a>.</p>

<h2 id="children">Children</h2>
<p>The service is not directed at children, and you must be at least 18 to use it.</p>

<h2 id="changes">Changes</h2>
<p>When this policy changes, we update the date at the top of this page. For a significant change, we will also tell signed-in users in the app.</p>`;
}

function termsBody(facts: LegalFacts): string {
  return `<p class="lead">These terms govern your use of the hosted Atoma service at atoma.run: the website, the web app, the MCP server at <code>https://atoma.run/mcp</code> and the Atoma plugins for Claude and Codex, which connect to that server. By signing in or using the service, you agree to them. If you use it on behalf of an organisation, you confirm that you may accept them for it.</p>

<h2 id="operator">1. Who provides the service</h2>
<p>The service is provided by ${LEGAL_OPERATOR_NAME}, a sole proprietor established in Greece, ${LEGAL_OPERATOR_ADDRESS} ("we", "us"). Contact: ${mail}.</p>

<h2 id="service">2. The service</h2>
<p>Atoma takes a request, plans the work, has AI agents carry it out in isolated workspaces, checks the result against the request, and delivers it. A run may deliver, stop incomplete or fail. The service is in beta: features, limits and models change, and it can be interrupted for maintenance or deployment.</p>
<p>Atoma is under active development and has not been independently audited. Use it to evaluate the product and for work that contains no confidential, personal or otherwise sensitive data.</p>

<h2 id="accounts">3. Accounts and organisations</h2>
<ul>
<li>You sign in with a GitHub, Google or ChatGPT account and must be at least 18 years old.</li>
<li>Your first sign-in creates an organisation that you own. Owners and admins invite members and assign roles, and they are responsible for who they admit and for their organisation's use of the service.</li>
<li>Keep your API tokens and other credentials secret. You are responsible for activity carried out with them until you revoke them.</li>
</ul>

<h2 id="commons">4. Shared learning</h2>
<p>Atoma is a shared-learning service, and this is part of what you agree to:</p>
<ul>
<li>Every run can use the platform's catalogue of agents, learned recipes and trust history. What a run learns can update that catalogue and history for later runs, including runs by other organisations. Contributions are reused without an individual approval step, and learned recipes may include executable code.</li>
<li>By submitting material to the service, you authorise us to process it to perform your runs, and to extract, store, adapt and reuse learned recipes within the service, including running them for other organisations. This does not transfer ownership of your material, and it does not give other organisations access to your projects.</li>
<li>Projects, workspaces, run traces and retrieval corpora stay within their organisation. The catalogue, recipes and trust history are shared across the service. Learning does not guarantee that every detail of its inputs is removed, so do not submit material that must never influence a shared recipe.</li>
<li>Platform administrators can read across organisation boundaries for operation and support. These reads are recorded, and organisation owners are notified.</li>
</ul>

<h2 id="decisions">5. Decisions taken by TypeSafe</h2>
<p>Every run uses Decision, TypeSafe's model (<a href="https://typesafe.ai">typesafe.ai</a>), at our cost, for bounded decisions: which agent or recipe takes a step, whether a plan or result can be approved without a model review, and whether a newly learned recipe duplicates an existing one. For each decision we send TypeSafe its content: the step's task text and constraints, the candidates' descriptions, and the plan or result under review with excerpts of its evidence. TypeSafe processes it under its own terms and may retain it. A decision that TypeSafe does not take is taken by the run's model, and final acceptance of a delivery never rests with TypeSafe.</p>

<h2 id="content">6. Your content and the results</h2>
<ul>
<li>Submit only material that you have the rights and permissions to have processed and reused as described here.</li>
<li>As between you and us, you keep your rights in the material you submit and in the results delivered to you, subject to the rights of third parties and to the licences of any material the results include. Using Atoma does not by itself place results under Atoma's software licence.</li>
<li>Results and learned recipes are generated by AI and can be wrong, incomplete, insecure or unsuitable. Neither the checks a run performs nor a recipe's trust history guarantee correctness. Review and test results before you rely on, distribute or deploy them.</li>
<li>A result is published to GitHub only after you accept it. Hosted previews and applications are provided for evaluation.</li>
</ul>

<h2 id="use">7. Acceptable use</h2>
<p>You must not:</p>
<ul>
<li>try to access another organisation's data, or bypass the sandbox, container isolation, network restrictions, rate limits or other execution boundaries;</li>
<li>misuse credentials, or use the service with another person's account or credentials without their permission;</li>
<li>use the service to break the law, infringe others' rights, create malware, attack or scan systems you are not authorised to test, send spam, or produce content that exploits or harms children;</li>
<li>submit personal data about other people without a lawful basis, or special categories of personal data;</li>
<li>overload or disrupt the service, or resell access to it without our written agreement.</li>
</ul>
<p>Report vulnerabilities privately, as described on the <a href="/support#security">support page</a>, instead of exploiting them.</p>

<h2 id="providers">8. Models, credentials and costs</h2>
<ul>
<li>The service is free of charge during the beta. We do not bill you, and we do not meter or rebill model providers' charges. If paid plans are introduced, they will be offered under separate terms and never applied without your agreement.</li>
<li>Runs use the models configured for your organisation. When you supply a provider API key or connect a personal subscription, that use is subject to the provider's own terms and is charged by the provider to you. You are responsible for being entitled to use it this way. Some processing, such as run titles and TypeSafe's decisions, is at our cost.</li>
<li>Limits apply, such as concurrent runs, run duration and the assistant's daily allowance. These are admission limits, not spending caps.</li>
</ul>

<h2 id="retention">9. Retention</h2>
<p>A finished run's trace and workspace become eligible for deletion ${facts.runRetentionDays} days after it ends, unless they are still needed (for example, as the base of later work or a publication that is not finished). Eligibility is not an exact deletion date. Run records, payer attribution and the history of what was learned are kept separately, and removing a run's files does not automatically withdraw what was learned from it. The <a href="/privacy#retention">privacy policy</a> gives the details, and your rights over personal data are not affected.</p>

<h2 id="suspension">10. Suspension and ending</h2>
<p>You can stop using the service at any time, and ask us to delete your account or organisation by writing to ${mail}. We may suspend or end access that breaches these terms or puts the service or other users at risk, and we may change or discontinue the service. We will give reasonable notice where we can, so that you can retrieve your results.</p>

<h2 id="warranty">11. No warranty</h2>
<p>The service is provided free of charge, "as is" and "as available", without warranties of any kind, to the extent the law permits. We do not guarantee that it will be uninterrupted, secure or free of errors, or that any result will be correct or fit for a particular purpose.</p>

<h2 id="liability">12. Liability</h2>
<p>To the extent the law permits, we are not liable for indirect or consequential loss, for loss of data, profit or business, or for the consequences of relying on, distributing or deploying results. This does not limit liability for intent or gross negligence, for death or personal injury, or any other liability that cannot be limited by law, and it does not affect the mandatory rights of consumers.</p>

<h2 id="software">13. The open-source software</h2>
<p>Atoma's software is published under the GNU Affero General Public License v3.0 (<a href="https://github.com/atoma-run/atoma">github.com/atoma-run/atoma</a>). These terms cover the hosted service only. They do not restrict the rights that licence grants you, or replace the licences of third-party material.</p>

<h2 id="law">14. Law and disputes</h2>
<p>These terms are governed by Greek law, and the courts of Athens have jurisdiction. If you are a consumer, you keep the protection of the mandatory rules of the country where you live, and you may also bring proceedings there.</p>

<h2 id="changes">15. Changes</h2>
<p>We may update these terms. The date at the top shows the current version, and we will announce significant changes in the app before they take effect. If you keep using the service after a change takes effect, you accept the updated terms.</p>`;
}

function supportBody(): string {
  return `<p class="lead">Help with the hosted Atoma service at atoma.run, its MCP server and the Atoma plugins for Claude and Codex.</p>

<div class="box">
<p><strong>Contact:</strong> ${mail}</p>
<p>We usually answer within a few business days. Atoma is operated by one person in Athens, Greece (UTC+2, UTC+3 in summer).</p>
</div>

<h2 id="request">What to include</h2>
<ul>
<li>the email address you sign in with, and your organisation's name;</li>
<li>the project and, for a run, its link or identifier, as shown in the app or returned by the MCP tools;</li>
<li>what you expected, what happened instead, and when (with your time zone);</li>
<li>for a connection problem, the client you use (Claude, Claude Code, Codex or another MCP client) and the exact error message.</li>
</ul>
<p>Never send passwords, API keys or tokens. We will never ask for them.</p>

<h2 id="connect">Connecting Atoma to Claude or Codex</h2>
<ul>
<li><strong>Claude Code:</strong> run <code>claude plugin marketplace add atoma-run/atoma</code>, then <code>claude plugin install atoma@atoma</code>. Run <code>/mcp</code> in a session and sign in to Atoma in your browser.</li>
<li><strong>Any MCP client:</strong> add the server <code>https://atoma.run/mcp</code> (HTTP transport). Your client opens Atoma's sign-in page and asks you to approve access for your active organisation. You can also create an API token in the app's settings.</li>
<li>The tools you see depend on your role. Viewers can read, members can start and cancel runs, and admins also choose the organisation's models.</li>
<li>To revoke a client's access, remove it from the MCP access panel in the app's settings.</li>
</ul>

<h2 id="common">Common questions</h2>
<h3>A run is waiting for me</h3>
<p>A run can pause to ask you a question it cannot settle alone. Answer it in the app or through your MCP client, and the run resumes.</p>
<h3>A run stopped incomplete or failed</h3>
<p>Open the run to see the step where it stopped and why. You can continue the project with a clarified goal. If you believe Atoma itself is at fault, send us the run's link.</p>
<h3>My result was not published to GitHub</h3>
<p>Publication needs an accepted result and an organisation connected to a GitHub App installation that can write to the target repository. The app shows each run's publication status.</p>
<h3>Deleting my data</h3>
<p>Write to ${mail} from the address linked to your account, and say what to delete: your account, an organisation you own, or a project. The <a href="/privacy#rights">privacy policy</a> describes your rights.</p>

<h2 id="security">Reporting a vulnerability</h2>
<p>Report security issues privately through GitHub's private vulnerability reporting on <a href="https://github.com/atoma-run/atoma/security">github.com/atoma-run/atoma</a> (Security tab, then "Report a vulnerability"), or by email to ${mail}. Do not disclose them publicly before they are fixed, and do not include a live credential or anyone else's data.</p>

<h2 id="more">More</h2>
<ul>
<li><a href="/privacy">Privacy policy</a> and <a href="/terms">terms of service</a></li>
<li>Source code and documentation: <a href="https://github.com/atoma-run/atoma">github.com/atoma-run/atoma</a></li>
</ul>`;
}
