import * as path from 'path';

import {CompileCommand} from '../compilation-database';
import {Environment} from '../environment-variables';
import {fs} from '../pr';
import * as proc from '../proc';
import * as util from '../util';
import {varsForMsvcToolchain} from '../visual-studio';

import type {ModuleScanResult} from './index';
import {collectModuleScanResult, commandArguments, compilerPath, normalizePath, resolveCommandPath, ScanDepsModuleEntry, ScanDepsOutput, stableHash} from './util';

function optionValue(args: readonly string[], index: number, ...options: string[]): {value?: string; nextIndex: number} | undefined {
    const arg = args[index];
    const lowerArg = arg.toLowerCase();
    for (const option of options) {
        const lowerOption = option.toLowerCase();
        if (lowerArg === lowerOption)
            return {value: args[index + 1], nextIndex: index + 1};
        if (lowerArg.startsWith(lowerOption) && arg.length > option.length)
            return {value: arg.substring(option.length), nextIndex: index};
        if (lowerArg.startsWith(`${lowerOption}:`))
            return {value: arg.substring(option.length + 1), nextIndex: index};
    }
    return undefined;
}

function outputFromArguments(args: readonly string[]): string | undefined {
    for (let index = 0; index < args.length; index++) {
        const output = optionValue(args, index, '/Fo', '-Fo');
        if (output)
            return output.value;
    }
    return undefined;
}

function compileCommandOutput(entry: CompileCommand): string | undefined {
    return entry.output ?? outputFromArguments(commandArguments(entry));
}

function isSourceArgument(entry: CompileCommand, arg: string): boolean {
    if (arg.startsWith('/') || arg.startsWith('-'))
        return false;
    return normalizePath(resolveCommandPath(entry, arg)) === normalizePath(resolveCommandPath(entry, entry.file));
}

function isResponseModuleMap(argument: string): boolean {
    return argument.startsWith('@') && normalizePath(argument.substring(1)).endsWith('.modmap');
}

function filteredScanArguments(entry: CompileCommand): string[] {
    const args = commandArguments(entry);
    const filtered: string[] = [];
    for (let index = 1; index < args.length; index++) {
        const arg = args[index];
        const lower = arg.toLowerCase();
        if (lower === '/c' || lower === '-c' || isResponseModuleMap(arg) || isSourceArgument(entry, arg))
            continue;

        const skipped = optionValue(args, index,
            '/scanDependencies', '-scanDependencies',
            '/sourceDependencies', '-sourceDependencies',
            '/sourceDependencies:directives', '-sourceDependencies:directives',
            '/ifcOutput', '-ifcOutput',
            '/reference', '-reference',
            '/headerUnit', '-headerUnit');
        if (skipped) {
            index = skipped.nextIndex;
            continue;
        }

        if (lower === '/link')
            break;

        filtered.push(arg);
    }
    return filtered;
}

function hasObjectOutputArg(args: readonly string[]): boolean {
    return args.some(arg => arg.toLowerCase().startsWith('/fo') || arg.toLowerCase().startsWith('-fo'));
}

async function runMsvcScanDeps(
    entry: CompileCommand,
    temporaryDirectory: string,
    environment: Environment | undefined,
): Promise<ScanDepsOutput<ScanDepsModuleEntry> | undefined> {
    const args = commandArguments(entry);
    const compiler = args[0];
    const output = compileCommandOutput(entry);
    if (!compiler || !output)
        return undefined;

    const id = stableHash(`${entry.directory}\0${entry.file}\0${output}`);
    const scanOutputPath = path.join(temporaryDirectory, `${id}.json`);
    const sourcePath = resolveCommandPath(entry, entry.file);
    const scanArgs = [
        ...filteredScanArguments(entry),
        ...(hasObjectOutputArg(args) ? [] : [`/Fo${output}`]),
        '/scanDependencies', scanOutputPath,
        sourcePath,
    ];
    const execution = await proc.execute(compiler, scanArgs, null, {
        cwd: entry.directory,
        encoding: 'utf8',
        silent: true,
        showOutputOnError: true,
        environment,
    }).result;
    if (execution.retc !== 0)
        throw new Error(`MSVC dependency scan failed with code ${execution.retc}: ${execution.stderr}`);

    try {
        return JSON.parse((await fs.readFile(scanOutputPath)).toString()) as ScanDepsOutput<ScanDepsModuleEntry>;
    } catch (error) {
        throw new Error(`Failed to parse MSVC dependency scan output: ${util.errorToString(error)}`);
    }
}

export async function scan(
    entry: CompileCommand,
): Promise<ModuleScanResult | undefined> {
    const toolchainPath = compilerPath(entry);
    if (!toolchainPath)
        return undefined;

    const buildDirectory = entry.directory;
    const temporaryDirectory = path.join(buildDirectory, '.clangd', 'scan-deps', 'msvc');
    await fs.mkdir_p(temporaryDirectory);
    const environment = await varsForMsvcToolchain(toolchainPath);
    const scanDepsOutput = await runMsvcScanDeps(entry, temporaryDirectory, environment);
    return scanDepsOutput ? collectModuleScanResult(scanDepsOutput, buildDirectory, resolveCommandPath(entry, entry.file)) : undefined;
}
