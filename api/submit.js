"use strict";

// Handles both homepage forms:
//   formType "problem": "Fix this for me" under the problem cards (ticked problems + something else)
//   anything else:      the main contact form (with topics picked on the Services page)
// Emails you the enquiry, sends the visitor a short confirmation, and optionally
// logs it to a Google Sheet.

const {
  EMAIL_RE, clean, esc, makeTransport, fromName, notifyTo, autoReplyEnabled, parseBody, tableRow,
} = require("./_mail");

// Caps keep a single submission from producing a giant email or sheet row.
const LIMITS = {
  formType: 20,
  name: 120,
  email: 200,
  company: 160,
  model: 80,
  interest: 80,
  crm: 120,
  topics: 4000,
  problems: 1000,
  other: 500,
  message: 5000,
};

function list(value) {
  return value ? value.split("; ").filter(Boolean) : [];
}

// Ticked problems plus the free-text "something else", as one list.
function problemList(d) {
  const items = list(d.problems);
  if (d.other) items.push("Something else: " + d.other);
  return items;
}

function bulletList(items) {
  return `<ul style="margin:0;padding-left:18px">${items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`;
}

// ─── Email to you ─────────────────────────────────────────────────────────────
async function sendNotification(transport, d) {
  const isProblem = d.formType === "problem";
  const problems = problemList(d);
  const topics = list(d.topics);

  const rows = [
    tableRow("Name", `<strong>${esc(d.name)}</strong>`),
    tableRow("Email", `<a href="mailto:${esc(d.email)}">${esc(d.email)}</a>`, true),
    tableRow("Company", esc(d.company || "—")),
  ];
  if (isProblem) {
    rows.push(tableRow("Problems to fix", problems.length ? bulletList(problems) : "—", true));
  } else {
    rows.push(
      tableRow("Revenue model", esc(d.model || "—"), true),
      tableRow("Interested in", esc(d.interest || "—")),
      tableRow("CRM today", esc(d.crm || "—"), true),
      tableRow("Topics", topics.length ? bulletList(topics) : "—"),
    );
  }
  rows.push(tableRow(isProblem ? "Notes" : "Message", d.message ? esc(d.message).replace(/\n/g, "<br>") : "—", !isProblem));

  const html = `<div style="font-family:Arial,sans-serif;max-width:640px;color:#0F1B2D">
  <h2 style="margin:0 0 16px">${isProblem ? "New “fix this for me” request" : "New RevOps enquiry"}</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    ${rows.join("\n    ")}
  </table>
  <p style="margin-top:20px;font-size:13px;color:#4A5568">Hit reply to answer ${esc(d.name)} directly.</p>
</div>`;

  const who = `${d.name}${d.company ? ", " + d.company : ""}`;
  await transport.sendMail({
    from: `"${fromName()} · Website" <${process.env.GMAIL_USER}>`,
    to: notifyTo(),
    replyTo: d.email,
    subject: isProblem ? `Fix request: ${who}` : `New RevOps enquiry: ${who}`,
    html,
  });
  return true;
}

// ─── Confirmation to the visitor ──────────────────────────────────────────────
async function sendAutoReply(transport, d) {
  if (!autoReplyEnabled()) return false;

  const isProblem = d.formType === "problem";
  const first = d.name.split(/\s+/)[0];
  const items = isProblem ? problemList(d) : list(d.topics);
  const booking = process.env.BOOKING_URL;
  const site = process.env.SITE_URL;

  const intro = isProblem
    ? "Thanks for getting in touch. I’ll look at what you’ve described and come back shortly with how I’d approach it."
    : "Thanks for getting in touch. I’ve got your note and will reply shortly with a few times to talk.";
  const listLead = isProblem ? "You asked me to look at:" : "You mentioned you’d like to cover:";

  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;line-height:1.6;color:#0F1B2D;font-size:15px">
  <p>Hi ${esc(first)},</p>
  <p>${intro}</p>
  ${items.length ? `<p>${listLead}</p>${bulletList(items)}` : ""}
  ${booking ? `<p>If it’s easier, you can <a href="${esc(booking)}">pick a time on my calendar</a> directly.</p>` : ""}
  <p>Speak soon,<br>${esc(fromName())}</p>
  ${site ? `<p style="font-size:13px;color:#4A5568;border-top:1px solid #DDE2E8;padding-top:12px;margin-top:24px"><a href="${esc(site)}" style="color:#4A5568">${esc(site.replace(/^https?:\/\//, ""))}</a></p>` : ""}
</div>`;

  await transport.sendMail({
    from: `"${fromName()}" <${process.env.GMAIL_USER}>`,
    to: d.email,
    replyTo: notifyTo(),
    subject: "Thanks for getting in touch",
    html,
  });
  return true;
}

// ─── Optional Google Sheets log ───────────────────────────────────────────────
async function logToSheet(d) {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!clientEmail || !privateKey || !sheetId) return false;

  // Loaded only when configured, so the function stays fast without Sheets.
  const { google } = require("googleapis");
  const jwt = new google.auth.JWT({
    email: clientEmail,
    key: privateKey.replace(/\\n/g, "\n").replace(/\r/g, "").trim(),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  await jwt.authorize();

  const tab = process.env.GOOGLE_SHEET_TAB || "Leads";
  const sheets = google.sheets({ version: "v4", auth: jwt });
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${tab}!A:K`,
    // RAW so a value starting with "=" is stored as text, not run as a formula.
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        new Date().toISOString(),
        d.name, d.email, d.company, d.model, d.interest, d.crm, d.topics, d.message,
        problemList(d).join("; "),
        d.formType === "problem" ? "Fix request" : "Contact",
      ]],
    },
  });
  return true;
}

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = parseBody(req);
  if (!body) return res.status(400).json({ error: "Invalid request" });

  // Bots fill the hidden "website" field; pretend success so they move on.
  if (clean(body.website, 200)) return res.status(200).json({ success: true });

  const d = {};
  Object.keys(LIMITS).forEach((key) => { d[key] = clean(body[key], LIMITS[key]); });

  if (!d.name) return res.status(400).json({ error: "Name is required" });
  if (!EMAIL_RE.test(d.email)) return res.status(400).json({ error: "A valid email is required" });
  if (d.formType === "problem" && !d.problems && !d.other) {
    return res.status(400).json({ error: "Choose at least one problem" });
  }

  const transport = makeTransport();
  const results = { notified: false, autoReply: false, sheet: false };

  const tasks = [
    transport ? sendNotification(transport, d).then((ok) => { results.notified = ok; }) : Promise.resolve(),
    transport ? sendAutoReply(transport, d).then((ok) => { results.autoReply = ok; }) : Promise.resolve(),
    logToSheet(d).then((ok) => { results.sheet = ok; }),
  ];
  const names = ["notification", "autoReply", "sheet"];
  const settled = await Promise.allSettled(tasks);
  settled.forEach((s, i) => {
    if (s.status === "rejected") console.error(`[submit] ${names[i]} failed:`, s.reason && s.reason.message);
  });

  console.log("[submit]", d.formType || "contact", JSON.stringify(results));

  // The enquiry only counts as received if it reached you by email or the sheet.
  if (!results.notified && !results.sheet) {
    return res.status(502).json({ error: "Could not deliver the message" });
  }
  return res.status(200).json({ success: true });
};
