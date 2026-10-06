# Fractional RevOps website

Static site on Vercel with two serverless functions.

```
index.html          Homepage
health-check.html   RevOps Health Check (served at /health-check)
nda.html            Mutual NDA: sign online or upload your own (served at /nda)
nda-text.json       The NDA wording, used by both the page and the signed PDF
api/submit.js       Contact form → emails you, sends the visitor a confirmation, optional Google Sheets log
api/nda.js          NDA signing → PDF emailed to both sides; NDA upload → emailed to you
api/_mail.js        Shared email helpers (the underscore keeps it from becoming an endpoint)
vercel.json         Clean URLs, security headers, function timeouts
.env.example        Environment variables to set in Vercel
```

## Site settings

In `index.html`, the `SITE SETTINGS` block at the bottom holds your email, LinkedIn and booking link. Empty values hide that link.

## Deploy (GitHub → Vercel)

1. Create a new **private** GitHub repo, e.g. `fractional-revops-site`.
2. From this folder:
   ```
   git init
   git add .
   git commit -m "Initial site"
   git branch -M main
   git remote add origin https://github.com/<you>/fractional-revops-site.git
   git push -u origin main
   ```
3. In Vercel: **Add New → Project**, import the repo. Framework preset **Other**, leave build and output settings empty.
4. Add the values from `.env.example` under **Settings → Environment Variables**. At minimum `GMAIL_USER` and `GMAIL_APP_PASSWORD`.
5. Redeploy if you added variables after the first deploy (**Deployments → ⋯ → Redeploy**). Functions only pick up variables on a new deployment.
6. Test once yourself: send the contact form, sign the NDA with your own details, and upload a small PDF on the NDA page. Check all the emails arrive.

Every push to `main` redeploys automatically.

## Mutual NDA

- The wording lives in `nda-text.json` and was extracted directly from `2026-10-06-MutualNDA_GoWarm.pdf`. The only changes are the three blanks, replaced by `{{EFFECTIVE_DATE}}`, `{{COUNTERPARTY}}` and `{{COUNTERPARTY_ADDRESS}}`.
- If you change the wording, also bump `version`. Each signed PDF records the version and a fingerprint (SHA-256) of the exact text signed.
- `NDA_AUTO_COUNTERSIGN=true` applies your signature automatically. Leave it `false` to countersign each one yourself.
- Signed PDFs are not stored on the server. The email to you is your record, so keep those emails.

## Custom domain

**Settings → Domains → Add.** If the domain is bought through Vercel it connects automatically. Otherwise add the DNS records Vercel shows at your registrar. Then set `SITE_URL` to the new address.

## Local preview

Double-clicking `index.html` shows the pages, but the forms and the NDA text only work when served. Run `npx vercel dev` from this folder with a `.env` file filled in.
