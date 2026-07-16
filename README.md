# Doc to Markdown Converter

Batch convert **PDF**, **DOCX**, **TXT**, **CSV**, and **HTML** files to clean **Markdown** (.md).
Drop in 50+ files at once, convert them all, and download individually or as a single ZIP.

- PDF conversion with heading detection (big text → `#` headings, bullets → lists)
- Word (.docx) conversion that keeps structure (headings, lists, tables, links)
- CSV → Markdown tables
- 100% local — no files are uploaded to any server

## Run in the browser

Just open `index.html` in any modern browser. That's it.

> Note: the app loads its conversion libraries (pdf.js, mammoth, turndown, jszip)
> from a CDN, so it needs an internet connection the first time it loads.

## Run as a desktop app (development)

Requires [Node.js](https://nodejs.org) (v18 or newer).

```bash
npm install
npm start
```

## Build a Windows .exe

```bash
npm install
npm run dist
```

The finished `.exe` will be in the `dist/` folder (a **portable** exe —
one file, no installer needed, just double-click to run).

To build an installer instead of a portable exe, change `"target": "portable"`
to `"target": "nsis"` in `package.json`.

## Upload to GitHub

1. Create a new repository on [github.com/new](https://github.com/new) (e.g. `doc-to-markdown-converter`). Don't add a README (this project already has one).
2. In this project folder, run:

```bash
git init
git add .
git commit -m "Initial commit: doc to markdown converter"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/doc-to-markdown-converter.git
git push -u origin main
```

3. Refresh GitHub — your project is live.

## Project structure

```
index.html    # the entire app (UI + conversion logic)
main.js       # Electron wrapper (desktop window)
package.json  # scripts + exe build config
```
