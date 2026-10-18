import { describe, expect, it } from "@jest/globals";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { extractCodeGraph } from "../src/codegraph/extract.js";
import { parseGraph } from "../src/mcp_tools/codeGraph.js";

const FIXTURE = resolve("tests/fixtures/codegraph");

const EXPECTED_IMPORTS = [
    "a.dart -> b.dart",
    "a.ts -> b.ts",
    "com/x/J.java -> com/x/Util.java",
    "k.py -> pkg/mod.py",
    "m.js -> n.js",
    "ui.tsx -> b.ts",
    "ui.tsx -> src/lib/u.ts"
];

const EXPECTED_CALLS = [
    "a.dart::A.m -> a.dart::foo EXTRACTED",
    "a.dart::foo -> a.dart::A EXTRACTED",
    "a.dart::foo -> a.dart::A.m EXTRACTED",
    "a.dart::foo -> b.dart::bee EXTRACTED",
    "a.kt::A.z -> a.kt::foo EXTRACTED",
    "a.swift::A.z -> a.swift::foo EXTRACTED",
    "a.ts::A.run -> b.ts::helper EXTRACTED",
    "a.ts::A.run -> a.ts::A.stop EXTRACTED",
    "a.ts::arrow -> a.ts::A EXTRACTED",
    "c.cs::C.M -> c.cs::C.N EXTRACTED",
    "com/x/Ctl.java::Ctl.u -> com/x/Util.java::Util.u INFERRED",
    "com/x/J.java::J.m -> com/x/Util.java::Util.u EXTRACTED",
    "com/x/J.java::J.m -> com/x/J.java::J.n EXTRACTED",
    "g.go::T.M -> g.go::F EXTRACTED",
    "k.py::K.go -> pkg/mod.py::util EXTRACTED",
    "k.py::K.go -> k.py::K.go2 EXTRACTED",
    "m.js::main -> n.js::run EXTRACTED",
    "r.rs::R.m -> r.rs::free EXTRACTED",
    "r.rs::R.m -> r.rs::R.n EXTRACTED",
    "t.dart::T.go -> t.dart::Svc.run INFERRED",
    "t.dart::T.go -> t.dart::Other.run INFERRED",
    "t.dart::T.go -> t.dart::Box EXTRACTED",
    "t.dart::T.go -> t.dart::Box.run INFERRED",
    "t.kt::T.go -> t.kt::Svc.run INFERRED",
    "t.kt::T.go -> t.kt::Other.run INFERRED",
    "t.kt::T.go -> t.kt::Box EXTRACTED",
    "t.kt::T.go -> t.kt::Box.run INFERRED",
    "t.swift::T.go -> t.swift::Svc.run INFERRED",
    "t.swift::T.go -> t.swift::Other.run INFERRED",
    "t.swift::T.go -> t.swift::Box EXTRACTED",
    "t.swift::T.go -> t.swift::Box.run INFERRED",
    "ui.tsx::Button -> b.ts::helper EXTRACTED",
    "ui.tsx::Page -> ui.tsx::Button EXTRACTED",
    "ui.tsx::Page -> src/lib/u.ts::useU EXTRACTED"
];

async function summarize(root: string) {
    const graph = await extractCodeGraph(root);
    const edges = (relation: string) =>
        graph.edges
            .filter((e) => e.relation === relation)
            .map((e) => `${e.source} -> ${e.target}${e.confidence ? ` ${e.confidence}` : ""}`)
            .sort();
    return { graph, imports: edges("imports"), calls: edges("calls"), contains: edges("contains") };
}

describe("extractCodeGraph", () => {
    it("emits exactly the expected imports and calls across all 10 languages", async () => {
        const { imports, calls } = await summarize(FIXTURE);
        expect(imports).toEqual([...EXPECTED_IMPORTS].sort());
        expect(calls).toEqual([...EXPECTED_CALLS].sort());
    });

    it("does not guess a member call's target in a class the caller never names", async () => {
        const { calls } = await summarize(FIXTURE);
        expect(calls.some((c) => c.startsWith("com/x/Other.java::Other.same ->"))).toBe(false);
    });

    it("builds file and qualified symbol nodes with graphify-style labels and line locations", async () => {
        const { graph } = await summarize(FIXTURE);
        const byId = new Map(graph.nodes.map((n) => [n.id, n]));
        expect(byId.get("a.ts")).toEqual({ id: "a.ts", label: "a.ts", source_file: "a.ts", source_location: "L1" });
        expect(byId.get("a.ts::A")).toMatchObject({ label: "A", source_location: "L2" });
        expect(byId.get("a.ts::A.run")).toMatchObject({ label: ".run()", source_location: "L3" });
        expect(byId.get("a.ts::I")).toMatchObject({ label: "I" });
        expect(byId.get("a.ts::E")).toMatchObject({ label: "E" });
        expect(byId.get("ui.tsx::Button")).toMatchObject({ label: "Button()" });
        expect(byId.get("pkg/mod.py::util")).toMatchObject({ label: "util()" });
        expect(byId.get("pkg/mod.py::U.util")).toMatchObject({ label: ".util()" });
        expect(byId.get("g.go::T.M")).toMatchObject({ label: ".M()" });
        expect(byId.get("r.rs::R.m")).toMatchObject({ label: ".m()" });
        expect(byId.get("a.dart::A.q")).toMatchObject({ label: ".q()" });
        expect(byId.get("a.swift::A.q")).toMatchObject({ label: ".q()" });
        expect(byId.get("a.kt::O.o")).toMatchObject({ label: ".o()" });
        expect(byId.get("c.cs::C.M")).toMatchObject({ label: ".M()" });
        expect(byId.get("com/x/J.java::J.m")).toMatchObject({ source_file: "com/x/J.java" });
        expect(new Set(graph.nodes.map((n) => n.id)).size).toBe(graph.nodes.length);
    });

    it("links files to top-level symbols and types to their methods", async () => {
        const { contains } = await summarize(FIXTURE);
        expect(contains).toEqual(expect.arrayContaining([
            "a.ts -> a.ts::A",
            "a.ts::A -> a.ts::A.run",
            "g.go::T -> g.go::T.M",
            "r.rs::R -> r.rs::R.m",
            "a.dart::A -> a.dart::A.q",
            "a.swift::A -> a.swift::A.q",
            "pkg/mod.py -> pkg/mod.py::util",
            "pkg/mod.py::U -> pkg/mod.py::U.util"
        ]));
    });

    it("gives the same graph through the folder walk when the root is not a git repo, and skips files over 1 MB", async () => {
        const dir = mkdtempSync(join(tmpdir(), "pam-codegraph-"));
        try {
            cpSync(FIXTURE, dir, { recursive: true });
            writeFileSync(join(dir, "huge.ts"), `export function huge() {}\n${"//".padEnd(1024 * 1024 + 10, "x")}\n`);
            mkdirIgnored(dir);
            const walked = await summarize(dir);
            const fromGit = await summarize(FIXTURE);
            expect(walked.imports).toEqual(fromGit.imports);
            expect(walked.calls).toEqual(fromGit.calls);
            expect(walked.graph.nodes.some((n) => n.source_file === "huge.ts")).toBe(false);
            expect(walked.graph.nodes.some((n) => n.source_file.startsWith("node_modules/"))).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("produces a graph parseGraph keeps whole", async () => {
        const { graph } = await summarize(FIXTURE);
        const nodes = parseGraph(graph, FIXTURE);
        const kept = nodes.reduce((sum, n) => sum + n.out.length, 0);
        const unique = new Set(graph.edges.filter((e) => e.source !== e.target).map((e) => `${e.source}|${e.target}|${e.relation}`));
        expect(nodes).toHaveLength(graph.nodes.length);
        expect(kept).toBe(unique.size);
    });
});

function mkdirIgnored(dir: string) {
    cpSync(join(dir, "b.ts"), join(dir, "node_modules", "dep", "index.ts"), { recursive: true });
}
