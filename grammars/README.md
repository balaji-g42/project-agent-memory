# Vendored tree-sitter grammars

Every grammar the code indexer uses lives here as a `.wasm` file, loaded by web-tree-sitter 0.27.1. No grammar is an npm dependency: the npm grammar packages run a native install script (`node-gyp-build`) that can need C++ build tools on the user's machine, and only their `.wasm` is needed.

| File | Language | Source | Obtained | License |
|---|---|---|---|---|
| `tree-sitter-typescript.wasm` | TypeScript | npm `tree-sitter-typescript@0.23.2` | copied unmodified | `LICENSE-tree-sitter-typescript` |
| `tree-sitter-tsx.wasm` | TSX | npm `tree-sitter-typescript@0.23.2` | copied unmodified | `LICENSE-tree-sitter-typescript` |
| `tree-sitter-javascript.wasm` | JavaScript | npm `tree-sitter-javascript@0.25.0` | copied unmodified | `LICENSE-tree-sitter-javascript` |
| `tree-sitter-python.wasm` | Python | npm `tree-sitter-python@0.25.0` | copied unmodified | `LICENSE-tree-sitter-python` |
| `tree-sitter-java.wasm` | Java | npm `tree-sitter-java@0.23.5` | copied unmodified | `LICENSE-tree-sitter-java` |
| `tree-sitter-rust.wasm` | Rust | npm `tree-sitter-rust@0.24.0` | copied unmodified | `LICENSE-tree-sitter-rust` |
| `tree-sitter-go.wasm` | Go | npm `tree-sitter-go@0.25.0` | copied unmodified | `LICENSE-tree-sitter-go` |
| `tree-sitter-c_sharp.wasm` | C# | npm `tree-sitter-c-sharp@0.23.5` | copied unmodified | `LICENSE-tree-sitter-c-sharp` |
| `tree-sitter-kotlin.wasm` | Kotlin | npm `@tree-sitter-grammars/tree-sitter-kotlin@1.1.0` | copied unmodified | `LICENSE-tree-sitter-kotlin` |
| `tree-sitter-dart.wasm` | Dart | https://github.com/nielsenko/tree-sitter-dart release `0.2.0` (commit `b57d734c84f510bbd524097902cab671e4dbfca9`) | built with tree-sitter-cli 0.27.1 | `LICENSE-tree-sitter-dart` |
| `tree-sitter-swift.wasm` | Swift | https://github.com/alex-pinkus/tree-sitter-swift release `0.7.3` (commit `b8b22bffbb3441780e6471665bacfb263741c86a`) | release asset, unmodified | `LICENSE-tree-sitter-swift` |

All licenses are MIT.

The extractor queries in `src/codegraph/queries/` are adapted from each grammar's upstream `queries/tags.scm` (same sources and licenses as above), with import patterns added. Kotlin and Swift queries are written for this project.

Do not use `tree-sitter-wasms@0.1.13` or npm `tree-sitter-dart@1.0.0`: their `.wasm` files use the old dynamic-linking format, which web-tree-sitter 0.27 refuses in `getDylinkMetadata`. npm `tree-sitter-swift@0.7.1` ships no `.wasm`.

## Refresh

Copied from npm (pick the version, then copy the `.wasm` and `LICENSE` from the package root):

```bash
npm pack tree-sitter-go@0.25.0 && tar -xzf tree-sitter-go-0.25.0.tgz package/tree-sitter-go.wasm package/LICENSE
```

Dart, built (no admin rights, Emscripten or Docker needed; the CLI downloads wasi-sdk on first use):

```bash
git init dart-src && cd dart-src
git remote add origin https://github.com/nielsenko/tree-sitter-dart
git fetch --depth 1 origin b57d734c84f510bbd524097902cab671e4dbfca9 && git checkout FETCH_HEAD
cd .. && npx -y tree-sitter-cli@0.27.1 build --wasm dart-src -o tree-sitter-dart.wasm
```

Swift, release asset:

```bash
curl -L -o tree-sitter-swift.wasm https://github.com/alex-pinkus/tree-sitter-swift/releases/download/0.7.3/tree-sitter-swift.wasm
```

After any refresh, load and parse each file with the pinned web-tree-sitter version before committing.
