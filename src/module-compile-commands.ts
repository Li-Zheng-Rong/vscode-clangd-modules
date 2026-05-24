import * as path from "path";

import { CompileCommand, CompilationDatabase } from "./compilation-database";
import { fs } from "./pr";
import * as shlex from "./shlex";
import * as util from "./util";

interface ModuleRef {
    name: string;
    path: string;
}

interface ModuleCommandArgs {
    output?: string;
    inputs: ModuleRef[];
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

export interface BuildGeneratedCompileCommandsOptions {
    isGccModuleProducer?: (entry: CompileCommand) => boolean | Promise<boolean>;
}

type ParsedCommand = ModuleCommandArgs & {
    command: Omit<GeneratedCompileCommand, "arguments">;
    argsWithoutModmap: string[];
};

function resolveCommandPath(entry: CompileCommand, value: string): string {
    const unquoted = value.replace(/^"|"$/g, "");
    return util.platformNormalizePath(
        path.isAbsolute(unquoted)
            ? unquoted
            : path.resolve(entry.directory, unquoted),
    );
}

function pcmPath(filePath: string): string {
    const parsed = path.parse(filePath);
    return util.platformNormalizePath(path.join(parsed.dir, `${parsed.name}.pcm`));
}

function optionValue(
    args: readonly string[],
    index: number,
    ...options: string[]
): { value?: string; nextIndex: number } | undefined {
    const arg = args[index];
    for (const option of options) {
        if (arg === option) return { value: args[index + 1], nextIndex: index + 1 };

        const prefix = `${option}=`;
        if (arg.startsWith(prefix))
            return { value: arg.slice(prefix.length), nextIndex: index };
    }
    return undefined;
}

function parseNamedModuleRef(value: string, entry: CompileCommand): ModuleRef | undefined {
    const equals = value.indexOf("=");
    if (equals <= 0 || equals === value.length - 1) return undefined;

    return {
        name: value.slice(0, equals),
        path: pcmPath(resolveCommandPath(entry, value.slice(equals + 1))),
    };
}

function parseClangOrMsvcArgs(args: readonly string[], entry: CompileCommand): ModuleCommandArgs {
    const parsed: ModuleCommandArgs = { inputs: [] };
    for (let i = 0; i < args.length; i++) {
        const output = optionValue(args, i, "-fmodule-output", "-ifcOutput", "/ifcOutput");
        if (output) {
            if (output.value)
                parsed.output = pcmPath(resolveCommandPath(entry, output.value));
            i = output.nextIndex;
            continue;
        }

        const input = optionValue(args, i, "-fmodule-file", "-reference", "/reference");
        if (input) {
            const ref = input.value ? parseNamedModuleRef(input.value, entry) : undefined;
            if (ref)
                parsed.inputs.push(ref);
            i = input.nextIndex;
        }
    }
    return parsed;
}

function mergeModuleArgs(target: ModuleCommandArgs, update: ModuleCommandArgs): void {
    if (update.output)
        target.output = update.output;
    target.inputs.push(...update.inputs);
}

async function readModmapLines(entry: CompileCommand, modmapPath: string): Promise<string[]> {
    try {
        return (await fs.readFile(resolveCommandPath(entry, modmapPath))).toString().split(/\r?\n/);
    } catch {
        return [];
    }
}

async function parseClangOrMsvcModmap(entry: CompileCommand, modmapPath: string): Promise<ModuleCommandArgs> {
    const parsed: ModuleCommandArgs = { inputs: [] };
    for (const line of await readModmapLines(entry, modmapPath))
        mergeModuleArgs(parsed, parseClangOrMsvcArgs([...shlex.splitCommandLine(line)], entry));
    return parsed;
}

async function parseGccModmap(
    entry: CompileCommand,
    modmapPath: string,
    isProducer: boolean,
): Promise<ModuleCommandArgs> {
    const refs: ModuleRef[] = [];
    for (const rawLine of await readModmapLines(entry, modmapPath)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("$"))
            continue;

        const args = [...shlex.splitCommandLine(line)];
        if (args.length >= 2)
            refs.push({ name: args[0], path: pcmPath(resolveCommandPath(entry, args[1])) });
    }

    if (refs.length === 0)
        return { inputs: [] };
    return isProducer ? { output: refs[0].path, inputs: refs.slice(1) } : { inputs: refs };
}

async function parseCompileCommand(
    entry: CompileCommand,
    options: BuildGeneratedCompileCommandsOptions,
): Promise<ParsedCommand> {
    const args = entry.arguments ?? [...shlex.splitCommandLine(entry.command)];
    const parsed: ParsedCommand = {
        command: {
            directory: entry.directory,
            file: entry.file,
            ...(entry.output ? { output: entry.output } : {}),
        },
        argsWithoutModmap: [],
        inputs: [],
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith("@")) {
            mergeModuleArgs(parsed, await parseClangOrMsvcModmap(entry, arg.slice(1)));
            continue;
        }

        const gccMapper = optionValue(args, i, "-fmodule-mapper");
        if (gccMapper) {
            if (gccMapper.value) {
                mergeModuleArgs(parsed, await parseGccModmap(
                    entry,
                    gccMapper.value,
                    (await options.isGccModuleProducer?.(entry)) === true,
                ));
            }
            i = gccMapper.nextIndex;
            continue;
        }

        parsed.argsWithoutModmap.push(arg);
    }

    if (parsed.output)
        parsed.inputs = parsed.inputs.filter(input => input.path !== parsed.output);
    return parsed;
}

function buildModuleGraph(entries: readonly ParsedCommand[], diagnostics: string[]): Map<string, ModuleRef[]> {
    const graph = new Map<string, ModuleRef[]>();
    for (const entry of entries) {
        if (!entry.output)
            continue;

        if (graph.has(entry.output)) {
            diagnostics.push(`Duplicate module output path ${entry.output}`);
        } else {
            graph.set(entry.output, entry.inputs);
        }
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

function addModuleArgs(args: readonly string[], modules: ModuleCommandArgs): string[] {
    const moduleArgs = [
        ...(modules.output ? ["-x", "c++-module", `-fmodule-output=${modules.output}`] : []),
        ...modules.inputs.map(input => `-fmodule-file=${input.name}=${input.path}`),
    ];
    if (moduleArgs.length === 0)
        return [...args];

    const insertAt = args.indexOf("--");
    if (insertAt < 0)
        return [...args, ...moduleArgs];

    return [...args.slice(0, insertAt), ...moduleArgs, ...args.slice(insertAt)];
}

export async function buildGeneratedCompileCommandsFromCompilationDatabase(
    database: CompilationDatabase,
    options: BuildGeneratedCompileCommandsOptions = {},
): Promise<GeneratedCompileCommands> {
    const entries = await Promise.all(
        database.entries().map(entry => parseCompileCommand(entry, options)),
    );
    const diagnostics: string[] = [];
    const graph = buildModuleGraph(entries, diagnostics);
    const commands = entries.map(entry => ({
        ...entry.command,
        arguments: addModuleArgs(entry.argsWithoutModmap, {
            output: entry.output,
            inputs: expandModuleInputs(entry.inputs, graph),
        }),
    }));

    return { commands, diagnostics };
}
