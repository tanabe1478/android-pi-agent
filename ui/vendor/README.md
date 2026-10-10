# Marked browser lexer

`marked.js` is the unchanged ESM distribution of Marked **18.0.11**, copied read-only
from the existing Pi development dependency. Pi also uses Marked for Markdown
parsing. No package download or dependency installation was performed.

- Upstream: https://github.com/markedjs/marked
- License: MIT; full notice in `marked.LICENSE`, also included in Android packaging
- SHA-256 (`marked.js`): `05e41134d075ad3a009a748d6c779c3d83cea9b942be911c2d9abade36d1dd31`
- SHA-256 (`marked.LICENSE`): `8e3a3f82f59a60958f56ca08f445647c32a4733dc7ca6c2c46f6eb898471ab9c`

This is a vendored presentation asset, not another Pi backend or CLI. Generated
third-party code is not reformatted. Update the version, source hashes, license,
and regression checks together when replacing it.

`../markdown.js` consumes lexer tokens and creates allowlisted DOM elements.
It does not use Marked's HTML output, `innerHTML`, raw HTML execution, or remote
image loading. Code/text use text nodes; links permit only HTTP(S) without userinfo.
Native Android navigation restrictions remain in effect.
