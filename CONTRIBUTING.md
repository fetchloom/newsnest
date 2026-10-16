# Contributing

Thanks for helping. Freepost is small on purpose, so a few ground rules keep it that way.

## Setup

Needs Node 24 or newer. There is nothing to install.

```sh
node server.ts                 # http://127.0.0.1:8700
node --test test/*.test.ts     # the whole test suite, a few seconds, sends no real mail
```

## Principles

- **No dependencies.** Use Node's built-ins (`node:sqlite`, `node:http`, `node:test`). A new package needs a very good reason.
- **TypeScript with a little plain JavaScript.** Node strips the types when it runs the files, so types are not checked at runtime; keep them accurate anyway.
- **Minimal and clear.** Match the style of the file you are in. Prefer a small, readable change to a clever one.
- **Nothing the browser draws itself.** The dashboard uses its own dialogs, menus and pickers (`src/client/app/controls.ts`). A test fails if `alert`, `confirm`, `prompt`, `<select>` or the browser's validation bubbles come back.
- **Escape by construction.** The dashboard builds the page with `h()` and text nodes so data can never become markup. Don't use `innerHTML` with anything that came from the API.

## Making a change

1. Open an issue first for anything big, so we can agree on the shape.
2. Add or update a test next to the code you change (`test/`). The fake DOM in `test/dom-shim.ts` renders every dashboard page, so UI changes can be tested without a browser.
3. Run the suite, then open a pull request that explains what changed and why.

## Layout

See the end of the README for where things live.
