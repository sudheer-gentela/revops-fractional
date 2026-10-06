"use strict";

// Mutual NDA endpoint.
//   mode "sign":   the visitor accepts DeepConnect's Mutual NDA online. A PDF of the
//                  exact text they were shown, plus an electronic-signature record,
//                  is emailed to both sides and returned for download.
//   mode "upload": the visitor sends their own NDA; it is emailed to you as an attachment.

const crypto = require("crypto");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const {
  EMAIL_RE, clean, esc, makeTransport, fromName, notifyTo, autoReplyEnabled, parseBody, clientIp, tableRow,
} = require("./_mail");
// Single source for the agreement wording: the /nda page renders the same file.
const NDA = require("../nda-text.json");

// Vercel caps request bodies at 4.5 MB and base64 adds about a third,
// so 3 MB is the largest file that reliably fits.
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

// The first bytes are checked too, so a renamed executable can't pass as a PDF.
const UPLOAD_TYPES = {
  pdf: { mime: "application/pdf", magic: "25504446" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", magic: "504b" },
  doc: { mime: "application/msword", magic: "d0cf11e0" },
};

// A fingerprint of the exact wording, recorded in the signed PDF so a later
// edit to nda-text.json can never be confused with what someone actually signed.
const DOC_HASH = crypto.createHash("sha256")
  .update(JSON.stringify({ v: NDA.version, intro: NDA.intro, sections: NDA.sections, closing: NDA.closing }))
  .digest("hex");

function fill(text, values) {
  return text.replace(/\{\{(\w+)\}\}/g, (m, key) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : m));
}

// The standard PDF fonts only cover Windows-1252; anything outside it becomes "?"
// instead of making the whole PDF fail.
const WINANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
function pdfSafe(text) {
  return Array.from(String(text).replace(/[\t ]/g, " ")).map((ch) => {
    const c = ch.codePointAt(0);
    return (c >= 0x20 && c <= 0x7e) || (c >= 0xa1 && c <= 0xff) || WINANSI_EXTRA.includes(ch) ? ch : "?";
  }).join("");
}

function formatDate(d) {
  return d.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
}

function slug(s) {
  return s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "Company";
}

function sameName(a, b) {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

// ─── PDF ──────────────────────────────────────────────────────────────────────
async function buildPdf(values, signer, audit, countersigned) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${NDA.title}: ${NDA.ourParty.name} and ${signer.company}`);
  pdf.setAuthor(NDA.ourParty.name);
  pdf.setCreationDate(audit.at);

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const ink = rgb(0.06, 0.11, 0.18);
  const muted = rgb(0.29, 0.33, 0.41);

  const W = 612, H = 792, M = 64, width = W - 2 * M; // US Letter, matching the source document
  let page = pdf.addPage([W, H]);
  let y = H - M;

  function ensure(h) {
    if (y - h < M) { page = pdf.addPage([W, H]); y = H - M; }
  }

  function text(str, opts) {
    const o = Object.assign({ size: 10, font: regular, color: ink, gap: 6, indent: 0 }, opts || {});
    const lineH = o.size * 1.42;
    const maxW = width - o.indent;
    const words = pdfSafe(str).split(/\s+/).filter(Boolean);
    let line = "";
    const flush = () => {
      ensure(lineH);
      page.drawText(line, { x: M + o.indent, y: y - o.size, size: o.size, font: o.font, color: o.color });
      y -= lineH;
      line = "";
    };
    words.forEach((w) => {
      const next = line ? line + " " + w : w;
      if (line && o.font.widthOfTextAtSize(next, o.size) > maxW) { flush(); line = w; } else { line = next; }
    });
    if (line) flush();
    y -= o.gap;
  }

  function rule() {
    ensure(14);
    page.drawLine({ start: { x: M, y: y - 4 }, end: { x: W - M, y: y - 4 }, thickness: 0.5, color: rgb(0.8, 0.83, 0.87) });
    y -= 14;
  }

  text(NDA.title.toUpperCase(), { size: 14, font: bold, gap: 14 });
  text(fill(NDA.intro, values), { gap: 12 });
  NDA.sections.forEach((s) => {
    ensure(40); // keep a heading with at least the start of its paragraph
    text(`${s.number}. ${s.heading}`, { font: bold, size: 10.5, gap: 4 });
    s.paragraphs.forEach((p) => text(fill(p, values), { gap: 8 }));
  });
  text(fill(NDA.closing, values), { gap: 18 });

  ensure(150);
  text(`Business: ${NDA.ourParty.name}`, { font: bold, gap: 4 });
  if (countersigned) {
    text(`Sign: ${NDA.ourParty.signerName}`, { font: italic, size: 13, gap: 2 });
    text("(signed electronically)", { size: 8, color: muted, gap: 4 });
  } else {
    text("Sign: countersignature to follow", { color: muted, gap: 4 });
  }
  text(`Name: ${NDA.ourParty.signerName}`, { gap: 2 });
  text(`Title: ${NDA.ourParty.signerTitle}`, { gap: 2 });
  if (countersigned) text(`Date: ${values.EFFECTIVE_DATE}`, { gap: 2 });
  y -= 14;

  ensure(120);
  text(`Company: ${signer.company}`, { font: bold, gap: 4 });
  text(`Sign: ${signer.signature}`, { font: italic, size: 13, gap: 2 });
  text("(signed electronically)", { size: 8, color: muted, gap: 4 });
  text(`Name: ${signer.fullName}`, { gap: 2 });
  text(`Title: ${signer.title}`, { gap: 2 });
  text(`Date: ${values.EFFECTIVE_DATE}`, { gap: 18 });

  ensure(130);
  rule();
  text("Electronic signature record", { font: bold, size: 9, gap: 4 });
  const rec = (k, v) => text(`${k}: ${v}`, { size: 8, color: muted, gap: 1 });
  rec("Signed by", `${signer.fullName} (${signer.email}) for ${signer.company}`);
  rec("Signed at", `${audit.at.toISOString()} (UTC)`);
  rec("IP address", audit.ip || "not available");
  rec("Browser", audit.userAgent || "not available");
  rec("Method", "Typed signature matching the signer's full name, with a confirmation that they read the agreement and are authorised to sign it");
  rec("Agreement version", `${NDA.version} (source: ${NDA.source})`);
  rec("Agreement SHA-256", DOC_HASH);

  return pdf.save();
}

// ─── Sign online ──────────────────────────────────────────────────────────────
async function handleSign(req, res, body, transport) {
  if (!NDA.ready) return res.status(503).json({ error: "Online signing is not available yet" });

  // Names go into the agreement itself, so stray double spaces are collapsed.
  const oneLine = (v, max) => clean(v, max).replace(/\s+/g, " ");
  const s = {
    fullName: oneLine(body.fullName, 120),
    title: oneLine(body.title, 120),
    company: oneLine(body.company, 200),
    address: clean(body.address, 300),
    email: clean(body.email, 200),
    signature: oneLine(body.signature, 120),
  };
  const missing = Object.keys(s).filter((k) => !s[k]);
  if (missing.length) return res.status(400).json({ error: "Please fill in: " + missing.join(", ") });
  if (!EMAIL_RE.test(s.email)) return res.status(400).json({ error: "A valid email is required" });
  if (!sameName(s.signature, s.fullName)) return res.status(400).json({ error: "Type your full name exactly as your signature" });
  if (body.agree !== true) return res.status(400).json({ error: "Please confirm you have read the NDA and can sign it" });

  const audit = {
    at: new Date(),
    ip: clientIp(req),
    userAgent: clean(req.headers && req.headers["user-agent"], 300),
  };
  const values = {
    EFFECTIVE_DATE: formatDate(audit.at),
    COUNTERPARTY: s.company,
    COUNTERPARTY_ADDRESS: s.address.replace(/\s*\n\s*/g, ", "),
  };
  // Pre-applying your signature is a business decision, so it stays off unless switched on.
  const countersigned = process.env.NDA_AUTO_COUNTERSIGN === "true";

  const pdfBytes = Buffer.from(await buildPdf(values, s, audit, countersigned));
  const filename = `Mutual-NDA-DeepConnect-${slug(s.company)}-${audit.at.toISOString().slice(0, 10)}.pdf`;
  const attachment = { filename, content: pdfBytes, contentType: "application/pdf" };

  const toYou = transport.sendMail({
    from: `"${fromName()} · Website" <${process.env.GMAIL_USER}>`,
    to: notifyTo(),
    replyTo: s.email,
    subject: `NDA signed online: ${s.company} (${s.fullName})`,
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;color:#0F1B2D">
  <h2 style="margin:0 0 16px">Mutual NDA signed online</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    ${tableRow("Company", `<strong>${esc(s.company)}</strong>`)}
    ${tableRow("Address", esc(values.COUNTERPARTY_ADDRESS), true)}
    ${tableRow("Signed by", `${esc(s.fullName)}, ${esc(s.title)}`)}
    ${tableRow("Email", `<a href="mailto:${esc(s.email)}">${esc(s.email)}</a>`, true)}
    ${tableRow("Effective date", esc(values.EFFECTIVE_DATE))}
  </table>
  <p style="margin-top:20px;font-size:14px">${countersigned
    ? "Your signature was applied automatically, so the attached PDF is fully executed."
    : "<strong>Action needed:</strong> countersign the attached PDF and send it back to the signer."}</p>
</div>`,
    attachments: [attachment],
  });

  const toSigner = transport.sendMail({
    from: `"${fromName()}" <${process.env.GMAIL_USER}>`,
    to: s.email,
    replyTo: notifyTo(),
    subject: `Your Mutual NDA with ${NDA.ourParty.name}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;line-height:1.6;color:#0F1B2D;font-size:15px">
  <p>Hi ${esc(s.fullName.split(/\s+/)[0])},</p>
  <p>Thanks for signing the Mutual NDA between ${esc(s.company)} and ${esc(NDA.ourParty.name)}. Your copy is attached.</p>
  <p>${countersigned
    ? "It has been signed by both parties, so this copy is final."
    : "I’ll countersign it and send you the fully executed copy shortly."}</p>
  <p>Best,<br>${esc(fromName())}</p>
</div>`,
    attachments: [attachment],
  });

  // Both copies must go out; otherwise the signer would think it's done when you have no record.
  await Promise.all([toYou, toSigner]);
  console.log("[nda] signed:", s.company, "| countersigned:", countersigned);

  return res.status(200).json({
    success: true,
    countersigned,
    filename,
    pdfBase64: pdfBytes.toString("base64"),
  });
}

// ─── Upload own NDA ───────────────────────────────────────────────────────────
async function handleUpload(req, res, body, transport) {
  const u = {
    name: clean(body.name, 120),
    email: clean(body.email, 200),
    company: clean(body.company, 200),
    note: clean(body.note, 2000),
    fileName: clean(body.fileName, 200),
  };
  if (!u.name || !u.company) return res.status(400).json({ error: "Please add your name and company" });
  if (!EMAIL_RE.test(u.email)) return res.status(400).json({ error: "A valid email is required" });

  const ext = (u.fileName.split(".").pop() || "").toLowerCase();
  const type = UPLOAD_TYPES[ext];
  if (!type) return res.status(400).json({ error: "Please upload a PDF or Word document" });

  const buf = Buffer.from(typeof body.fileData === "string" ? body.fileData : "", "base64");
  if (!buf.length) return res.status(400).json({ error: "The file was empty" });
  if (buf.length > MAX_UPLOAD_BYTES) return res.status(413).json({ error: "Please keep the file under 3 MB" });
  if (!buf.subarray(0, 4).toString("hex").startsWith(type.magic)) {
    return res.status(400).json({ error: "That file doesn’t look like a valid PDF or Word document" });
  }

  const safeName = u.fileName.replace(/[^\w.\- ]+/g, "_").slice(0, 120);

  await transport.sendMail({
    from: `"${fromName()} · Website" <${process.env.GMAIL_USER}>`,
    to: notifyTo(),
    replyTo: u.email,
    subject: `NDA received for review: ${u.company} (${u.name})`,
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;color:#0F1B2D">
  <h2 style="margin:0 0 16px">NDA uploaded for review</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    ${tableRow("Company", `<strong>${esc(u.company)}</strong>`)}
    ${tableRow("From", esc(u.name), true)}
    ${tableRow("Email", `<a href="mailto:${esc(u.email)}">${esc(u.email)}</a>`)}
    ${tableRow("Note", u.note ? esc(u.note).replace(/\n/g, "<br>") : "—", true)}
  </table>
  <p style="margin-top:20px;font-size:14px">Their NDA is attached. Reply to this email to answer them directly.</p>
</div>`,
    attachments: [{ filename: safeName, content: buf, contentType: type.mime }],
  });

  // The confirmation is a courtesy; if it fails the upload still reached you.
  if (autoReplyEnabled()) {
    try {
      await transport.sendMail({
        from: `"${fromName()}" <${process.env.GMAIL_USER}>`,
        to: u.email,
        replyTo: notifyTo(),
        subject: "Got your NDA",
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;line-height:1.6;color:#0F1B2D;font-size:15px">
  <p>Hi ${esc(u.name.split(/\s+/)[0])},</p>
  <p>Thanks for sending over ${esc(u.company)}’s NDA. I’ll review it and get back to you shortly, either with it signed or with any comments.</p>
  <p>Best,<br>${esc(fromName())}</p>
</div>`,
      });
    } catch (e) {
      console.error("[nda] upload confirmation failed:", e.message);
    }
  }

  console.log("[nda] upload:", u.company, safeName, buf.length, "bytes");
  return res.status(200).json({ success: true });
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

  const transport = makeTransport();
  if (!transport) return res.status(502).json({ error: "Email is not configured" });

  try {
    if (body.mode === "sign") return await handleSign(req, res, body, transport);
    if (body.mode === "upload") return await handleUpload(req, res, body, transport);
    return res.status(400).json({ error: "Unknown request" });
  } catch (e) {
    console.error("[nda] failed:", e && e.message);
    return res.status(502).json({ error: "Could not complete the request" });
  }
};
