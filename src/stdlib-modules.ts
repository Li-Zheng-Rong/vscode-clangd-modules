import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";

import { CodeModel } from "vscode-cmake-tools";
import { createLogger } from "./logging";
import * as util from "./util";

const log = createLogger('std-module');

interface StdlibModulesJson {
    modules: Array<{ "source-path": string }>;
}

const GCC_STDLIB_MODULE_JSON = "libstdc++.modules.json";
const stdlibModuleSourcePathCache = new Map<string, Promise<Set<string>>>();

function isGccLikeToolchain(toolchain: CodeModel.Toolchain): boolean {
    return /^(?:.+-)?(?:gcc|g\+\+)$/i.test(path.parse(toolchain.path).name);
}

async function loadStdlibModuleSourcePathsForCompiler(compilerPath: string): Promise<Set<string>> {
    const out = new Set<string>();
    try {
        const output = (
            await promisify(execFile)(compilerPath, [
                `--print-file-name=${GCC_STDLIB_MODULE_JSON}`,
            ])
        ).stdout.trim();
        if (!output || output === GCC_STDLIB_MODULE_JSON) return new Set();

        const modulesJsonPath = path.normalize(output);
        const json = JSON.parse(
            await fs.readFile(modulesJsonPath, "utf8"),
        ) as StdlibModulesJson;
        const baseDir = path.dirname(modulesJsonPath);
        for (const module of json.modules) {
            const sourcePath = module["source-path"];
            out.add(
                util.platformNormalizePath(
                    path.isAbsolute(sourcePath)
                        ? sourcePath
                        : path.join(baseDir, sourcePath),
                ),
            );
        }
    } catch (e) {
        log.warning(
            `Failed to load C++ std modules metadata for ${compilerPath}: ${e instanceof Error ? e.message : String(e)}`,
        );
    }
    return out;
}

export async function stdlibModuleSourcePathsForToolchain(toolchain: CodeModel.Toolchain): Promise<Set<string>> {
    if (!isGccLikeToolchain(toolchain)) return new Set();
    const cacheKey = util.platformNormalizePath(toolchain.path);
    let cached = stdlibModuleSourcePathCache.get(cacheKey);
    if (!cached) {
        cached = loadStdlibModuleSourcePathsForCompiler(toolchain.path);
        stdlibModuleSourcePathCache.set(cacheKey, cached);
    }
    return cached;
}
