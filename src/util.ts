import * as path from 'path';
import * as fs from 'fs';
import * as nls from 'vscode-nls';
import * as vscode from 'vscode';

nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

/**
 * Escape a string so it can be used as a regular expression
 */
export function escapeStringForRegex(str: string): string {
    return str.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, '\\$1');
}

/**
 * Replace all occurrences of `needle` in `str` with `what`
 * @param str The input string
 * @param needle The search string
 * @param what The value to insert in place of `needle`
 * @returns The modified string
 */
export function replaceAll(str: string, needle: string, what: string) {
    const pattern = escapeStringForRegex(needle);
    const re = new RegExp(pattern, 'g');
    return str.replace(re, what);
}

type NormalizationSetting = 'always' | 'never' | 'platform';
interface PathNormalizationOptions {
    normCase?: NormalizationSetting;
    normUnicode?: NormalizationSetting;
}

/**
 * Completely normalize/canonicalize a path.
 * Using `path.normalize` isn't sufficient. We want convert all paths to use
 * POSIX separators, remove redundant separators, and sometimes normalize the
 * case of the path.
 *
 * @param p The input path
 * @param opt Options to control the normalization
 * @returns The normalized path
 */
export function normalizePath(p: string, opt: PathNormalizationOptions): string {
    const normCase: NormalizationSetting = opt ? opt.normCase ? opt.normCase : 'never' : 'never';
    const normUnicode: NormalizationSetting = opt ? opt.normUnicode ? opt.normUnicode : 'never' : 'never';
    let norm = path.normalize(p);
    while (path.sep !== path.posix.sep && norm.includes(path.sep)) {
        norm = norm.replace(path.sep, path.posix.sep);
    }
    // Normalize for case an unicode
    switch (normCase) {
        case 'always':
            norm = norm.toLocaleLowerCase();
            break;
        case 'platform':
            if (process.platform === 'win32') {
                norm = norm.toLocaleLowerCase();
            }
            break;
        case 'never':
            break;
    }
    switch (normUnicode) {
        case 'always':
            norm = norm.normalize();
            break;
        case 'platform':
            if (process.platform === 'darwin') {
                norm = norm.normalize();
            }
            break;
        case 'never':
            break;
    }
    // Remove trailing slashes
    norm = norm.replace(/\/$/g, '');
    // Remove duplicate slashes
    while (norm.includes('//')) {
        norm = replaceAll(norm, '//', '/');
    }
    return norm;
}

/**
 * Normalizes the given path according to the platform's case and Unicode normalization rules.
 * @param p The path to normalize.
 * @returns The normalized path.
 */
export function platformNormalizePath(p: string): string {
    return normalizePath(p, { normCase: 'platform', normUnicode: 'platform' });
}

/**
 * Converts an error object to a human-readable string.
 * Only includes the error message, not the stack trace.
 * @param e The error object to convert.
 * @returns A string representation of the error message.
 */
export function errorToString(e: any): string {
    if (e.message) {
        return `\n\t${e.message}`;
    }
    return `\n\t${e.toString()}`;
}

/**
 * Checks if a directory exists at the specified path synchronously.
 * @param dirPath The path to the directory.
 * @returns True if the directory exists, false otherwise.
 */
export function checkDirectoryExistsSync(dirPath: string): boolean {
    try {
        return fs.statSync(dirPath).isDirectory();
    } catch (e) {
    }
    return false;
}

/**
 * Creates a directory if it does not exist synchronously.
 * @param dirPath The path to the directory.
 */
export function createDirIfNotExistsSync(dirPath: string | undefined): void {
    if (!dirPath) {
        return;
    }
    if (!checkDirectoryExistsSync(dirPath)) {
        try {
            fs.mkdirSync(dirPath, {recursive: true});
        } catch (e) {
            console.log(e);
        }
    }
}

export class InvalidVersionString extends Error {}

export interface Version {
    major: number;
    minor: number;
    patch: number;
}

export enum Ordering {
    Greater,
    Equivalent,
    Less,
}

/**
 * Parses a version string into a Version object.
 * The version string is expected to be in the format "major.minor.patch".
 * @param str The version string to parse.
 * @returns A Version object with the parsed major, minor, and patch numbers.
 * @throws InvalidVersionString if the input string is not a valid version string.
 */
export function parseVersion(str: string): Version {
    const version_re = /(\d+)\.(\d+)(\.(\d+))?(.*)/;
    const mat = version_re.exec(str);
    if (!mat) {
        throw new InvalidVersionString(localize('invalid.version.string', 'Invalid version string {0}', str));
    }
    const [, major, minor, , patch] = mat;
    return {
        major: parseInt(major ?? '0'),
        minor: parseInt(minor ?? '0'),
        patch: parseInt(patch ?? '0')
    };
}

/**
 * Compares two version objects or version strings.
 * @param a The first version object or version string to compare.
 * @param b The second version object or version string to compare.
 * @returns An Ordering enum value indicating whether the first version is less than, equal to, or greater than the second version.
 */
export function compareVersions(a: Version | string, b: Version | string): Ordering {
    if (typeof a === 'string') {
        a = parseVersion(a);
    }
    if (typeof b === 'string') {
        b = parseVersion(b);
    }
    // Compare major
    if (a.major > b.major) {
        return Ordering.Greater;
    } else if (a.major < b.major) {
        return Ordering.Less;
        // Compare minor
    } else if (a.minor > b.minor) {
        return Ordering.Greater;
    } else if (a.minor < b.minor) {
        return Ordering.Less;
        // Compare patch
    } else if (a.patch > b.patch) {
        return Ordering.Greater;
    } else if (a.patch < b.patch) {
        return Ordering.Less;
        // No difference:
    } else {
        return Ordering.Equivalent;
    }
}

/**
 * Compares two version objects.
 * @param va The first version object to compare.
 * @param vb The second version object to compare.
 * @returns A negative number if va < vb, zero if va == vb, and a positive number if va > vb.
 */
export function compareVersion(va: Version, vb: Version) {
    if (va.major !== vb.major) {
        return va.major - vb.major;
    }
    if (va.minor !== vb.minor) {
        return va.minor - vb.minor;
    }
    return va.patch - vb.patch;
}

/**
 * Retrieves the current instance of the clangd extension.
 * @returns The current instance of the clangd extension.
 * @throws An error if the extension is not found.
 */
export function thisExtension() {
    const extension = vscode.extensions.getExtension('li-zheng-rong.vscode-clangd-modules-support')
        ?? vscode.extensions.getExtension('ms-vscode.vscode-clangd');
    if (!extension) {
        throw new Error(localize('extension.is.undefined', 'Extension is undefined!'));
    }
    return extension;
}

/**
 * Retrieves the extension path of the current instance of the clangd extension.
 * @returns The extension path as a string.
 */
export function thisExtensionPath(): string {
    return thisExtension().extensionPath;
}
