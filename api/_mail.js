"use strict";

// Shared helpers for the site's form functions. The leading underscore stops
// Vercel from deploying this file as an endpoint of its own.

const nodemailer = require("nodemailer");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// Everything a visitor types ends up in HTML email, so it must be escaped.
function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function makeTransport() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.warn("[mail] GMAIL_USER or GMAIL_APP_PASSWORD not set");
    return null;
  }
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });
}

function fromName() {
  return process.env.FROM_NAME || "Sudheer Gentela";
}

function notifyTo() {
  return process.env.NOTIFY_EMAIL || process.env.GMAIL_USER;
}

function autoReplyEnabled() {
  return process.env.SEND_AUTO_REPLY !== "false";
}

// Vercel normally parses JSON bodies, but a raw string can arrive if the
// content type is missing, so handle both.
function parseBody(req) {
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { return null; }
  }
  return body && typeof body === "object" ? body : null;
}

function clientIp(req) {
  const fwd = req.headers && req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "";
}

// One labelled row for the notification emails' detail tables.
function tableRow(label, valueHtml, shade) {
  return `<tr${shade ? ' style="background:#F7F8F9"' : ""}><td style="padding:8px;color:#4A5568;width:150px;vertical-align:top">${esc(label)}</td><td style="padding:8px">${valueHtml}</td></tr>`;
}

module.exports = {
  EMAIL_RE,
  clean,
  esc,
  makeTransport,
  fromName,
  notifyTo,
  autoReplyEnabled,
  parseBody,
  clientIp,
  tableRow,
};
