import {CompilationDatabase, CompileCommand} from '../compilation-database';
import * as util from '../util';

import type {FileModuleImportExportEntries, ModuleExportEntry, ModuleImportEntry} from './index';
import {isGccToolchain} from './util';

interface ModuleRef {
    name: string;
    path: string;
}

interface ProvidedModules {
    byKey: Map<string, ModuleRef>;
    byName: Map<string, ModuleRef[]>;
}

export interface GeneratedCompileCommand {
    directory: string;
    file: string;
    output?: string;
    arguments: string[];
}

export interface GeneratedCompileCommands {
    commands: GeneratedCompileCommand[];
    diagnostics: string[];
}

function buildScanDepsByFile(scanDeps: readonly FileModuleImportExportEntries[], diagnostics: string[]): Map<string, FileModuleImportExportEntries> {
    const result = new Map<string, FileModuleImportExportEntries>();
    for (const entry of scanDeps) {
        const file = util.platformNormalizePath(entry.file);
        if (result.has(file))
            diagnostics.push(`Duplicate scan-deps source file ${file}`);
        else
            result.set(file, entry);
    }
    return result;
}

function moduleKey(module: ModuleExportEntry | ModuleImportEntry): string {
    return `${module.logicalName}\0${module.sourcePath ?? ""}`;
}

function buildProvidedModules(scanDeps: readonly FileModuleImportExportEntries[], diagnostics: string[]): ProvidedModules {
    const providedModules: ProvidedModules = { byKey: new Map(), byName: new Map() };
    for (const entry of scanDeps) {
        for (const exported of entry.exports) {
            const key = moduleKey(exported);
            const ref = { name: exported.logicalName, path: exported.pcmPath };
            if (providedModules.byKey.has(key)) {
                diagnostics.push(`Duplicate module export ${exported.logicalName} from ${exported.sourcePath}`);
                continue;
            }
            providedModules.byKey.set(key, ref);
            const refs = providedModules.byName.get(exported.logicalName) ?? [];
            refs.push(ref);
            providedModules.byName.set(exported.logicalName, refs);
        }
    }
    return providedModules;
}

function resolveImportedModule(imported: ModuleImportEntry, providedModules: ProvidedModules, diagnostics?: string[]): ModuleRef | undefined {
    const exact = providedModules.byKey.get(moduleKey(imported));
    if (exact)
        return exact;

    const candidates = providedModules.byName.get(imported.logicalName) ?? [];
    if (candidates.length === 1)
        return candidates[0];

    diagnostics?.push(candidates.length === 0
        ? `Missing module export for import ${imported.logicalName}`
        : `Ambiguous module import ${imported.logicalName} without source path`);
    return undefined;
}

function moduleOutput(entry: FileModuleImportExportEntries): string | undefined {
    return entry.exports[0]?.pcmPath;
}

function moduleInputs(
    entry: FileModuleImportExportEntries,
    providedModules: ProvidedModules,
    diagnostics?: string[],
): ModuleRef[] {
    const output = moduleOutput(entry);
    const inputs = entry.imports.flatMap(imported => {
        const ref = resolveImportedModule(imported, providedModules, diagnostics);
        return ref ? [ref] : [];
    });
    return output ? inputs.filter(input => input.path !== output) : inputs;
}

function buildModuleGraph(
    scanDeps: readonly FileModuleImportExportEntries[],
    providedModules: ProvidedModules,
    diagnostics: string[],
): Map<string, ModuleRef[]> {
    const graph = new Map<string, ModuleRef[]>();
    for (const entry of scanDeps) {
        const output = moduleOutput(entry);
        if (!output)
            continue;

        if (graph.has(output))
            diagnostics.push(`Duplicate module output path ${output}`);
        else
            graph.set(output, moduleInputs(entry, providedModules, diagnostics));
    }
    return graph;
}

function expandModuleInputs(inputs: readonly ModuleRef[], graph: ReadonlyMap<string, ModuleRef[]>): ModuleRef[] {
    const expanded = new Map<string, ModuleRef>();

    function visit(ref: ModuleRef) {
        if (expanded.has(ref.path))
            return;
        expanded.set(ref.path, ref);
        for (const dep of graph.get(ref.path) ?? [])
            visit(dep);
    }

    for (const input of inputs)
        visit(input);
    return [...expanded.values()];
}

function optionValue(args: readonly string[], index: number, ...options: string[]): {nextIndex: number} | undefined {
    const arg = args[index];
    for (const option of options) {
        if (arg === option)
            return {nextIndex: index + 1};
        if (arg.startsWith(`${option}=`))
            return {nextIndex: index};
    }
    return undefined;
}

function filterGeneratedArguments(args: readonly string[]): string[] {
    const filtered: string[] = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '-fmodules-ts')
            continue;

        const option = optionValue(args, index, '-fdeps-format');
        if (option) {
            index = option.nextIndex;
            continue;
        }

        filtered.push(arg);
    }
    return filtered;
}

function addModuleArgs(args: readonly string[], output: string | undefined, inputs: readonly ModuleRef[], addModuleLanguage: boolean): string[] {
    const moduleArgs = [
        ...(output ? [...(addModuleLanguage ? ["-x", "c++-module"] : []), `-fmodule-output=${output}`] : []),
        ...inputs.map(input => `-fmodule-file=${input.name}=${input.path}`),
    ];
    if (moduleArgs.length === 0)
        return [...args];

    const insertAt = args.indexOf("--");
    if (insertAt < 0)
        return [...args, ...moduleArgs];

    return [...args.slice(0, insertAt), ...moduleArgs, ...args.slice(insertAt)];
}

function buildCommand(
    command: CompileCommand,
    scanDeps: FileModuleImportExportEntries | undefined,
    providedModules: ProvidedModules,
    graph: ReadonlyMap<string, ModuleRef[]>,
): GeneratedCompileCommand {
    const output = scanDeps ? moduleOutput(scanDeps) : undefined;
    const inputs = scanDeps ? expandModuleInputs(moduleInputs(scanDeps, providedModules), graph) : [];
    const compiler = command.arguments[0];
    return {
        directory: command.directory,
        file: command.file,
        ...(command.output ? { output: command.output } : {}),
        arguments: addModuleArgs(filterGeneratedArguments(command.arguments), output, inputs, !compiler || !isGccToolchain(compiler)),
    };
}

export async function buildGeneratedCompileCommands(
    database: CompilationDatabase,
    scanDeps: readonly FileModuleImportExportEntries[],
): Promise<GeneratedCompileCommands> {
    const diagnostics: string[] = [];
    const scanDepsByFile = buildScanDepsByFile(scanDeps, diagnostics);
    const providedModules = buildProvidedModules(scanDeps, diagnostics);
    const graph = buildModuleGraph(scanDeps, providedModules, diagnostics);
    const commands = database.entries().map(entry => buildCommand(
        entry,
        scanDepsByFile.get(util.platformNormalizePath(entry.file)),
        providedModules,
        graph,
    ));

    return { commands, diagnostics };
}
