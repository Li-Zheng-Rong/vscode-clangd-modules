import * as path from 'path';

import {createLogger} from './logger';
import {fs} from './pr';
import * as util from './util';

const log = createLogger('cmake-file-api');

interface FileApiIndexObject {
  kind?: string;
  version?: {major?: number};
  jsonFile?: string;
}

interface FileApiIndex {
  objects?: FileApiIndexObject[];
}

interface FileApiCodemodel {
  paths?: {source?: string};
  configurations?: Array<{targets?: Array<{jsonFile?: string}>}>;
}

interface FileApiTargetFileSet {
  type?: string;
}

interface FileApiTargetSource {
  path?: string;
  fileSetIndex?: number;
}

interface FileApiTarget {
  fileSets?: FileApiTargetFileSet[];
  sources?: FileApiTargetSource[];
  interfaceSources?: FileApiTargetSource[];
}

function cmakeFileApiReplyDir(buildDirectory: string): string {
  return path.join(buildDirectory, '.cmake', 'api', 'v1', 'reply');
}

async function readTextIfExists(filePath: string): Promise<string|undefined> {
  try {
    return (await fs.readFile(filePath)).toString();
  } catch {
    return undefined;
  }
}

async function readJsonIfExists<T>(filePath: string): Promise<T|undefined> {
  const text = await readTextIfExists(filePath);
  if (!text)
    return undefined;

  try {
    return JSON.parse(text) as T;
  } catch (e) {
    log.warning(`Error parsing CMake file-api JSON ${filePath}: ${util.errorToString(e)}`);
    return undefined;
  }
}

async function latestIndexPath(buildDirectory: string): Promise<string|undefined> {
  const replyDir = cmakeFileApiReplyDir(buildDirectory);
  let files: string[];
  try {
    files = await fs.readdir(replyDir) as string[];
  } catch {
    return undefined;
  }

  const indexFiles = files.filter(file => /^index-.*\.json$/.test(file)).sort();
  const latest = indexFiles[indexFiles.length - 1];
  return latest ? path.join(replyDir, latest) : undefined;
}

function fileApiObjectPath(indexPath: string, jsonFile: string): string {
  return path.join(path.dirname(indexPath), jsonFile);
}

function resolveSourcePath(topSourceDirectory: string|undefined, sourcePath: string): string {
  if (path.isAbsolute(sourcePath))
    return util.platformNormalizePath(sourcePath);
  if (topSourceDirectory)
    return util.platformNormalizePath(path.resolve(topSourceDirectory, sourcePath));
  return util.platformNormalizePath(sourcePath);
}

function collectTargetCxxModuleSources(target: FileApiTarget, topSourceDirectory: string|undefined): string[] {
  const sources: string[] = [];
  for (const source of [...target.sources ?? [], ...target.interfaceSources ?? []]) {
    if (source.path === undefined || source.fileSetIndex === undefined)
      continue;
    if (target.fileSets?.[source.fileSetIndex]?.type !== 'CXX_MODULES')
      continue;
    sources.push(resolveSourcePath(topSourceDirectory, source.path));
  }
  return sources;
}

export async function collectCxxModuleFileSetSources(buildDirectory: string): Promise<Set<string>> {
  const sources = new Set<string>();
  const indexPath = await latestIndexPath(buildDirectory);
  if (!indexPath)
    return sources;

  const index = await readJsonIfExists<FileApiIndex>(indexPath);
  const codemodelObject = index?.objects?.find(
      object => object.kind === 'codemodel' && object.version?.major === 2 && object.jsonFile);
  if (!codemodelObject?.jsonFile)
    return sources;

  const codemodel = await readJsonIfExists<FileApiCodemodel>(fileApiObjectPath(indexPath, codemodelObject.jsonFile));
  if (!codemodel)
    return sources;

  for (const configuration of codemodel.configurations ?? []) {
    for (const targetRef of configuration.targets ?? []) {
      if (!targetRef.jsonFile)
        continue;
      const target = await readJsonIfExists<FileApiTarget>(fileApiObjectPath(indexPath, targetRef.jsonFile));
      if (!target)
        continue;
      for (const source of collectTargetCxxModuleSources(target, codemodel.paths?.source))
        sources.add(source);
    }
  }
  return sources;
}
