import * as path from 'path';

import {CompileCommand} from '../compilation-database';
import {fs} from '../pr';
import * as proc from '../proc';
import * as util from '../util';

import type {ModuleScanResult} from './index';
import {collectModuleScanResult, commandArguments, normalizePath, resolveCommandPath, ScanDepsModuleEntry, ScanDepsOutput, stableHash} from './util';

function outputFromArguments(args: readonly string[]): string | undefined {
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '-o')
            return args[index + 1];
        if (arg.startsWith('-o') && arg.length > 2)
            return arg.substring(2);
    }
    return undefined;
}

function compileCommandOutput(entry: CompileCommand): string | undefined {
    return entry.output ?? outputFromArguments(commandArguments(entry));
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

function isResponseModuleMap(argument: string): boolean {
    return argument.startsWith('@') && normalizePath(argument.substring(1)).endsWith('.modmap');
}

function filteredScanArguments(entry: CompileCommand): string[] {
    const args = commandArguments(entry);
    const sourcePath = normalizePath(resolveCommandPath(entry, entry.file));
    const filtered: string[] = [];
    for (let index = 1; index < args.length; index++) {
        const arg = args[index];
        if (arg === '-c' || arg === '-E' || isResponseModuleMap(arg))
            continue;

        const option = optionValue(args, index,
            '-o', '-x', '-MF', '-MT', '-MQ', '-fdeps-file', '-fdeps-target', '-fdeps-format', '-fmodule-mapper');
        if (option) {
            index = option.nextIndex;
            continue;
        }

        if (arg === '-MD' || arg === '-MMD' || arg === '-M' || arg === '-MM')
            continue;

        if (normalizePath(resolveCommandPath(entry, arg)) === sourcePath)
            continue;

        filtered.push(arg);
    }
    return filtered;
}

async function runGccScanDeps(
    entry: CompileCommand,
    temporaryDirectory: string,
): Promise<ScanDepsOutput<ScanDepsModuleEntry> | undefined> {
    const args = commandArguments(entry);
    const compiler = args[0];
    const output = compileCommandOutput(entry);
    if (!compiler || !output)
        return undefined;

    const id = stableHash(`${entry.directory}\0${entry.file}\0${output}`);
    const ddiPath = path.join(temporaryDirectory, `${id}.ddi`);
    const depPath = path.join(temporaryDirectory, `${id}.d`);
    const preprocessedPath = path.join(temporaryDirectory, `${id}.ii`);
    const sourcePath = resolveCommandPath(entry, entry.file);
    const scanArgs = [
        ...filteredScanArguments(entry),
        '-E',
        '-x', 'c++',
        sourcePath,
        '-MT', ddiPath,
        '-MD',
        '-MF', depPath,
        `-fdeps-file=${ddiPath}`,
        `-fdeps-target=${output}`,
        '-fdeps-format=p1689r5',
        '-o', preprocessedPath,
    ];
    const execution = await proc.execute(compiler, scanArgs, null, {
        cwd: entry.directory,
        encoding: 'utf8',
        silent: true,
        showOutputOnError: true,
    }).result;
    if (execution.retc !== 0)
        throw new Error(`g++ dependency scan failed with code ${execution.retc}: ${execution.stderr}`);

    try {
        return JSON.parse((await fs.readFile(ddiPath)).toString()) as ScanDepsOutput<ScanDepsModuleEntry>;
    } catch (error) {
        throw new Error(`Failed to parse g++ dependency scan output: ${util.errorToString(error)}`);
    }
}

export async function scan(
    entry: CompileCommand,
): Promise<ModuleScanResult | undefined> {
    const buildDirectory = entry.directory;
    const temporaryDirectory = path.join(buildDirectory, '.clangd', 'scan-deps', 'gcc');
    await fs.mkdir_p(temporaryDirectory);
    const scanDepsOutput = await runGccScanDeps(entry, temporaryDirectory);
    return scanDepsOutput ? collectModuleScanResult(scanDepsOutput, buildDirectory, resolveCommandPath(entry, entry.file)) : undefined;
}
