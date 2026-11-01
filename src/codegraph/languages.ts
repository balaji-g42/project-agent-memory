import { fileURLToPath } from "url";
import c from "./queries/c.js";
import c_sharp from "./queries/c_sharp.js";
import cpp from "./queries/cpp.js";
import dart from "./queries/dart.js";
import go from "./queries/go.js";
import java from "./queries/java.js";
import javascript from "./queries/javascript.js";
import kotlin from "./queries/kotlin.js";
import lua from "./queries/lua.js";
import php from "./queries/php.js";
import python from "./queries/python.js";
import ruby from "./queries/ruby.js";
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
const cc: LanguageSpec = { grammar: "cpp", query: cpp };

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
    ".swift": { grammar: "swift", query: swift },
    ".c": { grammar: "c", query: c },
    ".h": cc,
    ".cc": cc,
    ".cpp": cc,
    ".cxx": cc,
    ".hpp": cc,
    ".hh": cc,
    ".hxx": cc,
    ".php": { grammar: "php", query: php },
    ".rb": { grammar: "ruby", query: ruby },
    ".lua": { grammar: "lua", query: lua }
};
