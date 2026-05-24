import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel|undefined;

export function setLoggerOutputChannel(channel: vscode.OutputChannel) {
  outputChannel = channel;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

export function createLogger(component: string): Logger {
  function append(level: string, message: string) {
    outputChannel?.appendLine(`[${component}] ${level}: ${message}`);
  }

  return {
    debug: message => append('debug', message),
    info: message => append('info', message),
    warning: message => append('warning', message),
    error: message => append('error', message),
  };
}
