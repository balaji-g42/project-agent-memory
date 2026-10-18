import { fileURLToPath } from "url";
import c_sharp from "./queries/c_sharp.js";
import dart from "./queries/dart.js";
import go from "./queries/go.js";
import java from "./queries/java.js";
import javascript from "./queries/javascript.js";
import kotlin from "./queries/kotlin.js";
import python from "./queries/python.js";
import rust from "./queries/rust.js";
import swift from "./queries/swift.js";
import typescript, { tsx as tsxQuery } from "./queries/typescript.js";

export interface LanguageSpec {
    grammar: string;
    query: string;
}

export const GRAMMAR_DIR = fileURLToPath(new URL("../../grammars/", import.meta.url));

const ts: LanguageSpec = { grammar: "typescript", query: typescript };
const tsx: LanguageSpec = { grammar: "tsx", query: tsxQuery };
const js: LanguageSpec = { grammar: "javascript", query: javascript };
const kt: LanguageSpec = { grammar: "kotlin", query: kotlin };

export const LANGUAGES: Record<string, LanguageSpec> = {
    ".ts": ts,
    ".mts": ts,
    ".cts": ts,
    ".tsx": tsx,
    ".js": js,
    ".mjs": js,
    ".cjs": js,
    ".jsx": js,
    ".py": { grammar: "python", query: python },
    ".java": { grammar: "java", query: java },
    ".rs": { grammar: "rust", query: rust },
    ".go": { grammar: "go", query: go },
    ".cs": { grammar: "c_sharp", query: c_sharp },
    ".kt": kt,
    ".kts": kt,
    ".dart": { grammar: "dart", query: dart },
    ".swift": { grammar: "swift", query: swift }
};
