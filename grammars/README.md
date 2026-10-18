# Vendored tree-sitter grammars

Grammars with no `.wasm` on npm that web-tree-sitter 0.27 can load. Every other language comes from its npm grammar package.

| File | Source | Commit | Built with | License |
|---|---|---|---|---|
| `tree-sitter-dart.wasm` | https://github.com/UserNobody14/tree-sitter-dart | `0038280b774b65c1b89ba7fec50624d8baed9fe1` | tree-sitter-cli 0.27.1 | MIT, `LICENSE-tree-sitter-dart` |

Why: the npm `tree-sitter-dart@1.0.0` and `tree-sitter-wasms@0.1.13` files use the old dynamic-linking format, which web-tree-sitter 0.27 refuses in `getDylinkMetadata`.

## Rebuild

No admin rights, Emscripten or Docker needed; the CLI downloads wasi-sdk on first use.

```bash
git init dart-src && cd dart-src
git remote add origin https://github.com/UserNobody14/tree-sitter-dart
git fetch --depth 1 origin 0038280b774b65c1b89ba7fec50624d8baed9fe1 && git checkout FETCH_HEAD
cd .. && npx -y tree-sitter-cli@0.27.1 build --wasm dart-src -o tree-sitter-dart.wasm
```
