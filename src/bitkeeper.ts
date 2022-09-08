/* eslint-disable @typescript-eslint/naming-convention */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs, exists, realpath } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { fileURLToPath } from 'url';
import * as which from 'which';
import { EventEmitter } from 'events';
import * as iconv from '@vscode/iconv-lite-umd';
import * as filetype from 'file-type';
import { assign, groupBy, IDisposable, toDisposable, dispose, mkdirp, readBytes, detectUnicodeEncoding, Encoding, onceEvent, splitInChunks, Limiter, Versions, isWindows } from './util';
import { CancellationToken, ConfigurationChangeEvent, Progress, Uri, workspace } from 'vscode';
import { detectEncoding } from './encoding';
import { Ref, RefType, Branch, ForcePushMode, BkErrorCodes, LogOptions, Change, Status, CommitOptions, BranchQuery } from './api/bk';
import * as byline from 'byline';
import { StringDecoder } from 'string_decoder';

// https://bkhub.com/microsoft/vscode/issues/65693
const MAX_CLI_LENGTH = 30000;

export interface IBk {
	path: string;
	version: string;
}

export interface IFileStatus {
	bitkeeper: string;
	path: string;
	rename?: string;
}

export interface Stash {
	index: number;
	description: string;
}

// interface MutableRemote extends Remote {
// 	fetchUrl?: string;
// 	pushUrl?: string;
// 	isReadOnly: boolean;
// }

// TODO@eamodio: Move to bk.d.ts once we are good with the api
/**
 * Log file options.
 */
export interface LogFileOptions {
	/** Optional. The maximum number of log entries to retrieve. */
	readonly maxEntries?: number | string;
	/** Optional. The Bk sha (hash) to start retrieving log entries from. */
	readonly hash?: string;
	/** Optional. Specifies whether to start retrieving log entries in reverse order. */
	readonly reverse?: boolean;
	readonly sortByAuthorDate?: boolean;
}

function parseVersion(raw: string): string {
	let regex = /version: bk-([\d]+[.])*[\d]/gm;
	let res = regex.exec(raw);
	if (res) {
		return res[0].replace(/version: bk-/,'');
	}
	return "Unknown";
}

function findSpecificBk(path: string, onValidate: (path: string) => boolean): Promise<IBk> {
	return new Promise<IBk>((c, e) => {
		if (!onValidate(path)) {
			return e('bk not found');
		}

		const buffers: Buffer[] = [];
		const child = cp.spawn(path, ['--version']);
		child.stdout.on('data', (b: Buffer) => buffers.push(b));
		child.on('error', cpErrorHandler(e));
		child.on('exit', code => code ? e(new Error('Not found')) : c({ path, version: parseVersion(Buffer.concat(buffers).toString('utf8').trim()) }));
	});
}

function findBkDarwin(onValidate: (path: string) => boolean): Promise<IBk> {
	return new Promise<IBk>((c, e) => {
		cp.exec('which bk', (err, bkPathBuffer) => {
			if (err) {
				return e('bk not found');
			}

			const path = bkPathBuffer.toString().trim();

			function getVersion(path: string) {
				if (!onValidate(path)) {
					return e('bk not found');
				}

				// make sure bk executes
				cp.exec('bk --version', (err, stdout) => {

					if (err) {
						return e('bk not found');
					}

					return c({ path, version: parseVersion(stdout.trim()) });
				});
			}

			if (path !== '/usr/bin/bk') {
				return getVersion(path);
			}

			// must check if XCode is installed
			cp.exec('xcode-select -p', (err: any) => {
				if (err && err.code === 2) {
					// bk is not installed, and launching /usr/bin/bk
					// will prompt the user to install it

					return e('bk not found');
				}

				getVersion(path);
			});
		});
	});
}

function findSystemBkWin32(base: string, onValidate: (path: string) => boolean): Promise<IBk> {
	if (!base) {
		return Promise.reject<IBk>('Not found');
	}

	return findSpecificBk(path.join(base, 'BitKeeper', 'bk.exe'), onValidate);
}

function findBkWin32InPath(onValidate: (path: string) => boolean): Promise<IBk> {
	const whichPromise = new Promise<string>((c, e) => which('bk.exe', (err, path) => err ? e(err) : c(path?path:"")));
	return whichPromise.then(path => findSpecificBk(path, onValidate));
}

function findBkWin32(onValidate: (path: string) => boolean): Promise<IBk> {
	return findSystemBkWin32(process.env['ProgramW6432'] as string, onValidate)
		.then(undefined, () => findSystemBkWin32(process.env['ProgramFiles(x86)'] as string, onValidate))
		.then(undefined, () => findSystemBkWin32(process.env['ProgramFiles'] as string, onValidate))
		.then(undefined, () => findSystemBkWin32(path.join(process.env['LocalAppData'] as string, 'Programs'), onValidate))
		.then(undefined, () => findBkWin32InPath(onValidate));
}

export async function findBk(hints: string[], onValidate: (path: string) => boolean): Promise<IBk> {
	for (const hint of hints) {
		try {
			return await findSpecificBk(hint, onValidate);
		} catch {
			// noop
		}
	}

	try {
		switch (process.platform) {
			case 'darwin': return await findBkDarwin(onValidate);
			case 'win32': return await findBkWin32(onValidate);
			default: return await findSpecificBk('bk', onValidate);
		}
	} catch {
		// noop
	}

	throw new Error('Bk installation not found.');
}

export interface IExecutionResult<T extends string | Buffer> {
	exitCode: number;
	stdout: T;
	stderr: string;
}

function cpErrorHandler(cb: (reason?: any) => void): (reason?: any) => void {
	return err => {
		if (/ENOENT/.test(err.message)) {
			err = new BkError({
				error: err,
				message: 'Failed to execute bk (ENOENT)',
				bkErrorCode: BkErrorCodes.NotABkRepository
			});
		}

		cb(err);
	};
}

export interface SpawnOptions extends cp.SpawnOptions {
	input?: string;
	encoding?: string;
	log?: boolean;
	cancellationToken?: CancellationToken;
	onSpawn?: (childProcess: cp.ChildProcess) => void;
}

async function exec(child: cp.ChildProcess, cancellationToken?: CancellationToken): Promise<IExecutionResult<Buffer>> {
	if (!child.stdout || !child.stderr) {
		throw new BkError({ message: 'Failed to get stdout or stderr from bk process.' });
	}

	if (cancellationToken && cancellationToken.isCancellationRequested) {
		throw new BkError({ message: 'Cancelled' });
	}

	const disposables: IDisposable[] = [];

	const once = (ee: NodeJS.EventEmitter, name: string, fn: (...args: any[]) => void) => {
		ee.once(name, fn);
		disposables.push(toDisposable(() => ee.removeListener(name, fn)));
	};

	const on = (ee: NodeJS.EventEmitter, name: string, fn: (...args: any[]) => void) => {
		ee.on(name, fn);
		disposables.push(toDisposable(() => ee.removeListener(name, fn)));
	};

	let result = Promise.all<any>([
		new Promise<number>((c, e) => {
			once(child, 'error', cpErrorHandler(e));
			once(child, 'exit', c);
		}),
		new Promise<Buffer>(c => {
			const buffers: Buffer[] = [];
			on(child.stdout!, 'data', (b: Buffer) => buffers.push(b));
			once(child.stdout!, 'close', () => c(Buffer.concat(buffers)));
		}),
		new Promise<string>(c => {
			const buffers: Buffer[] = [];
			on(child.stderr!, 'data', (b: Buffer) => buffers.push(b));
			once(child.stderr!, 'close', () => c(Buffer.concat(buffers).toString('utf8')));
		})
	]) as Promise<[number, Buffer, string]>;

	if (cancellationToken) {
		const cancellationPromise = new Promise<[number, Buffer, string]>((_, e) => {
			onceEvent(cancellationToken.onCancellationRequested)(() => {
				try {
					child.kill();
				} catch (err:any) {
					// noop
				}

				e(new BkError({ message: 'Cancelled' }));
			});
		});

		result = Promise.race([result, cancellationPromise]);
	}

	try {
		const [exitCode, stdout, stderr] = await result;
		return { exitCode, stdout, stderr };
	} finally {
		dispose(disposables);
	}
}

export interface IBkErrorData {
	error?: Error;
	message?: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	bkErrorCode?: string;
	bkCommand?: string;
	bkArgs?: string[];
}

export class BkError {

	error?: Error;
	message: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	bkErrorCode?: string;
	bkCommand?: string;
	bkArgs?: string[];

	constructor(data: IBkErrorData) {
		if (data.error) {
			this.error = data.error;
			this.message = data.error.message;
		} else {
			this.error = undefined;
			this.message = '';
		}

		this.message = this.message || data.message || 'Bk error';
		this.stdout = data.stdout;
		this.stderr = data.stderr;
		this.exitCode = data.exitCode;
		this.bkErrorCode = data.bkErrorCode;
		this.bkCommand = data.bkCommand;
		this.bkArgs = data.bkArgs;
	}

	toString(): string {
		let result = this.message + ' ' + JSON.stringify({
			exitCode: this.exitCode,
			bkErrorCode: this.bkErrorCode,
			bkCommand: this.bkCommand,
			stdout: this.stdout,
			stderr: this.stderr
		}, null, 2);

		if (this.error) {
			result += (<any>this.error).stack;
		}

		return result;
	}
}

export interface IBkOptions {
	bkPath: string;
	userAgent: string;
	version: string;
	env?: any;
}

function getBkErrorCode(stderr: string): string | undefined {
	if (/Another bk process seems to be running in this repository|If no other bk process is currently running/.test(stderr)) {
		return BkErrorCodes.RepositoryIsLocked;
	} else if (/Authentication failed/i.test(stderr)) {
		return BkErrorCodes.AuthenticationFailed;
	} else if (/Not a bk repository/i.test(stderr)) {
		return BkErrorCodes.NotABkRepository;
	} else if (/bad config file/.test(stderr)) {
		return BkErrorCodes.BadConfigFile;
	} else if (/cannot make pipe for command substitution|cannot create standard input pipe/.test(stderr)) {
		return BkErrorCodes.CantCreatePipe;
	} else if (/Repository not found/.test(stderr)) {
		return BkErrorCodes.RepositoryNotFound;
	} else if (/unable to access/.test(stderr)) {
		return BkErrorCodes.CantAccessRemote;
	} else if (/branch '.+' is not fully merged/.test(stderr)) {
		return BkErrorCodes.BranchNotFullyMerged;
	} else if (/Couldn\'t find remote ref/.test(stderr)) {
		return BkErrorCodes.NoRemoteReference;
	} else if (/A branch named '.+' already exists/.test(stderr)) {
		return BkErrorCodes.BranchAlreadyExists;
	} else if (/'.+' is not a valid branch name/.test(stderr)) {
		return BkErrorCodes.InvalidBranchName;
	} else if (/Please,? commit your changes or stash them/.test(stderr)) {
		return BkErrorCodes.DirtyWorkTree;
	}

	return undefined;
}

// https://bkhub.com/microsoft/vscode/issues/89373
// https://bkhub.com/bk-for-windows/bk/issues/2478
function sanitizePath(path: string): string {
	return path.replace(/^([a-z]):\\/i, (_, letter) => `${letter.toUpperCase()}:\\`);
}

const COMMIT_FORMAT = '%H%n%aN%n%aE%n%at%n%ct%n%P%n%D%n%B';

export interface ICloneOptions {
	readonly parentPath: string;
	readonly progress: Progress<{ increment: number }>;
	readonly recursive?: boolean;
}

export class Bk {

	readonly path: string;
	readonly userAgent: string;
	readonly version: string;
	private env: any;
	private commandsToLog: string[] = [];

	private _onOutput = new EventEmitter();
	get onOutput(): EventEmitter { return this._onOutput; }

	constructor(options: IBkOptions) {
		this.path = options.bkPath;
		this.version = options.version;
		this.userAgent = options.userAgent;
		this.env = options.env || {};

		const onConfigurationChanged = (e?: ConfigurationChangeEvent) => {
			if (e !== undefined && !e.affectsConfiguration('bk.commandsToLog')) {
				return;
			}

			const config = workspace.getConfiguration('bk');
			this.commandsToLog = config.get<string[]>('commandsToLog', []);
		};

		workspace.onDidChangeConfiguration(onConfigurationChanged, this);
		onConfigurationChanged();
	}

	compareBkVersionTo(version: string): -1 | 0 | 1 {
		return Versions.compare(Versions.fromString(this.version), Versions.fromString(version));
	}

	open(repository: string, dotBk: { path: string; commonPath?: string }): Repository {
		return new Repository(this, repository, dotBk);
	}

	async init(repository: string): Promise<void> {
		await this.exec(repository, ['init']);
		return;
	}

	async clone(url: string, options: ICloneOptions, cancellationToken?: CancellationToken): Promise<string> {
		const baseFolderName = decodeURI(url).replace(/[\/]+$/, '').replace(/^.*[\/\\]/, '').replace(/\.bk$/, '') || 'repository';
		let folderName = baseFolderName;
		let folderPath = path.join(options.parentPath, folderName);
		let count = 1;

		while (count < 20 && await new Promise(c => exists(folderPath, c))) {
			folderName = `${baseFolderName}-${count++}`;
			folderPath = path.join(options.parentPath, folderName);
		}

		await mkdirp(options.parentPath);

		const onSpawn = (child: cp.ChildProcess) => {
			const decoder = new StringDecoder('utf8');
			const lineStream = new byline.LineStream({ encoding: 'utf8' });
			child.stderr!.on('data', (buffer: Buffer) => lineStream.write(decoder.write(buffer)));

			let totalProgress = 0;
			let previousProgress = 0;

			lineStream.on('data', (line: string) => {
				let match: RegExpExecArray | null = null;

				if (match = /Counting objects:\s*(\d+)%/i.exec(line)) {
					totalProgress = Math.floor(parseInt(match[1]) * 0.1);
				} else if (match = /Compressing objects:\s*(\d+)%/i.exec(line)) {
					totalProgress = 10 + Math.floor(parseInt(match[1]) * 0.1);
				} else if (match = /Receiving objects:\s*(\d+)%/i.exec(line)) {
					totalProgress = 20 + Math.floor(parseInt(match[1]) * 0.4);
				} else if (match = /Resolving deltas:\s*(\d+)%/i.exec(line)) {
					totalProgress = 60 + Math.floor(parseInt(match[1]) * 0.4);
				}

				if (totalProgress !== previousProgress) {
					options.progress.report({ increment: totalProgress - previousProgress });
					previousProgress = totalProgress;
				}
			});
		};

		try {
			const command = ['clone', url.includes(' ') ? encodeURI(url) : url, folderPath, '--progress'];
			if (options.recursive) {
				command.push('--recursive');
			}
			await this.exec(options.parentPath, command, {
				cancellationToken,
				env: { 'GIT_HTTP_USER_AGENT': this.userAgent },
				onSpawn,
			});
		} catch (err: any) {
			if (err.stderr) {
				err.stderr = err.stderr.replace(/^Cloning.+$/m, '').trim();
				err.stderr = err.stderr.replace(/^ERROR:\s+/, '').trim();
			}

			throw err;
		}

		return folderPath;
	}

	async getRepositoryRoot(repositoryPath: string): Promise<string> {
		const result = await this.exec(repositoryPath, ['root']);

		// Keep trailing spaces which are part of the directory name
		const repoPath = path.normalize(result.stdout.trimLeft().replace(/[\r\n]+$/, ''));

		if (isWindows) {
			const repoUri = Uri.file(repoPath);
			const pathUri = Uri.file(repositoryPath);
			if (repoUri.authority.length !== 0 && pathUri.authority.length === 0) {
				const match = /(?<=^\/?)([a-zA-Z])(?=:\/)/.exec(pathUri.path);
				if (match !== null) {
					const [, letter] = match;

					try {
						const networkPath = await new Promise<string | undefined>(resolve =>
							realpath.native(`${letter}:\\`, { encoding: 'utf8' }, (err, resolvedPath) =>
								resolve(err !== null ? undefined : resolvedPath),
							),
						);
						if (networkPath !== undefined) {
							return path.normalize(
								repoUri.fsPath.replace(
									networkPath,
									`${letter.toLowerCase()}:${networkPath.endsWith('\\') ? '\\' : ''}`
								),
							);
						}
					} catch { }
				}

				return path.normalize(pathUri.fsPath);
			}
		}

		return repoPath;
	}

	async getRepositoryDotBk(repositoryPath: string): Promise<{ path: string; commonPath?: string }> {
		const result = await this.exec(repositoryPath, ['root']);
		let dotBkPath = result.stdout;
		let commonDotBkPath = path.join(dotBkPath, 'BitKeeper');

		if (!path.isAbsolute(dotBkPath)) {
			dotBkPath = path.join(repositoryPath, dotBkPath);
		}
		dotBkPath = path.normalize(dotBkPath);

		if (commonDotBkPath) {
			if (!path.isAbsolute(commonDotBkPath)) {
				commonDotBkPath = path.join(repositoryPath, commonDotBkPath);
			}
			commonDotBkPath = path.normalize(commonDotBkPath);

			return { path: dotBkPath, commonPath: commonDotBkPath !== dotBkPath ? commonDotBkPath : undefined };
		}

		return { path: dotBkPath };
	}

	async exec(cwd: string, args: string[], options: SpawnOptions = {}): Promise<IExecutionResult<string>> {
		options = assign({ cwd }, options || {});
		return await this._exec(args, options);
	}

	async exec2(args: string[], options: SpawnOptions = {}): Promise<IExecutionResult<string>> {
		return await this._exec(args, options);
	}

	stream(cwd: string, args: string[], options: SpawnOptions = {}): cp.ChildProcess {
		options = assign({ cwd }, options || {});
		const child = this.spawn(args, options);

		if (options.log !== false) {
			const startTime = Date.now();
			child.on('exit', (_) => {
				this.log(`> bk ${args.join(' ')} [${Date.now() - startTime}ms]\n`);
			});
		}

		return child;
	}

	private async _exec(args: string[], options: SpawnOptions = {}): Promise<IExecutionResult<string>> {
		const child = this.spawn(args, options);

		options.onSpawn?.(child);

		if (options.input) {
			child.stdin!.end(options.input, 'utf8');
		}

		const startTime = Date.now();
		const bufferResult = await exec(child, options.cancellationToken);

		if (options.log !== false) {
			// command
			this.log(`> bk ${args.join(' ')} [${Date.now() - startTime}ms]\n`);

			// stdout
			if (bufferResult.stdout.length > 0 && args.find(a => this.commandsToLog.includes(a))) {
				this.log(`${bufferResult.stdout}\n`);
			}

			// stderr
			if (bufferResult.stderr.length > 0) {
				this.log(`${bufferResult.stderr}\n`);
			}
		}

		let encoding = options.encoding || 'utf8';
		encoding = iconv.encodingExists(encoding) ? encoding : 'utf8';

		const result: IExecutionResult<string> = {
			exitCode: bufferResult.exitCode,
			stdout: iconv.decode(bufferResult.stdout, encoding),
			stderr: bufferResult.stderr
		};

		if (bufferResult.exitCode) {
			return Promise.reject<IExecutionResult<string>>(new BkError({
				message: 'Failed to execute bk',
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
				bkErrorCode: getBkErrorCode(result.stderr),
				bkCommand: args[0],
				bkArgs: args
			}));
		}

		return result;
	}

	spawn(args: string[], options: SpawnOptions = {}): cp.ChildProcess {
		if (!this.path) {
			throw new Error('bk could not be found in the system.');
		}

		if (!options) {
			options = {};
		}

		if (!options.stdio && !options.input) {
			options.stdio = ['ignore', null, null]; // Unless provided, ignore stdin and leave default streams for stdout and stderr
		}

		options.env = assign({}, process.env, this.env, options.env || {}, {
			VSCODE_GIT_COMMAND: args[0],
			LC_ALL: 'en_US.UTF-8',
			LANG: 'en_US.UTF-8',
			GIT_PAGER: 'cat'
		});

		const cwd = this.getCwd(options);
		if (cwd) {
			options.cwd = sanitizePath(cwd);
		}

		return cp.spawn(this.path, args, options);
	}

	private getCwd(options: SpawnOptions): string | undefined {
		const cwd = options.cwd;
		if (typeof cwd === 'undefined' || typeof cwd === 'string') {
			return cwd;
		}

		if (cwd.protocol === 'file:') {
			return fileURLToPath(cwd);
		}

		return undefined;
	}

	private log(output: string): void {
		this._onOutput.emit('log', output);
	}

	async mergeFile(options: { input1Path: string; input2Path: string; basePath: string; diff3?: boolean }): Promise<string> {
		const args = ['merge', '-p', options.input1Path, options.basePath, options.input2Path];
		// if (options.diff3) {
		// 	args.push('--diff3');
		// } else {
		// 	args.push('--no-diff3');
		// }

		try {
			const result = await this.exec('', args);
			return result.stdout;
		} catch (err: any) {
			if (typeof err.stdout === 'string') {
				// The merge had conflicts, stdout still contains the merged result (with conflict markers)
				return err.stdout;
			} else {
				throw err;
			}
		}
	}
}

export interface Commit {
	hash: string;
	message: string;
	parents: string[];
	authorDate?: Date;
	authorName?: string;
	authorEmail?: string;
	commitDate?: Date;
	refNames: string[];
}

export class BkStatusParser {

	private lastRaw = '';
	private result: IFileStatus[] = [];

	get status(): IFileStatus[] {
		return this.result;
	}

	update(raw: string): void {
		let i = 0;
		let nextI: number | undefined;

		raw = this.lastRaw + raw;

		while ((nextI = this.parseEntry(raw, i)) !== undefined) {
			i = nextI;
		}

		this.lastRaw = raw.substr(i);
	}


	private parseEntry(raw: string, i: number): number | undefined {
		if (i + 7 >= raw.length) {
			return;
		}

		let lastIndex: number;
		const entry: IFileStatus = {
			bitkeeper: raw.substring(i, i + 7),
			rename: undefined,
			path: ''
		};
		i = i + 7;
		// space
		i++;
		//to the end

		// if (entry.x === 'R' || entry.x === 'C') {
		// 	lastIndex = raw.indexOf('\0', i);

		// 	if (lastIndex === -1) {
		// 		return;
		// 	}

		// 	entry.rename = raw.substring(i, lastIndex);
		// 	i = lastIndex + 1;
		// }

		lastIndex = raw.indexOf('\0', i);

		if (lastIndex === -1) {
			return;
		}

		entry.path = raw.substring(i, lastIndex);

		// If path ends with slash, it must be a nested bk repo
		if (entry.path[entry.path.length - 1] !== '/') {
			this.result.push(entry);
		}

		return lastIndex + 1;
	}
}

// 	private parseEntry(raw: string, i: number): number | undefined {
// 		if (i + 4 >= raw.length) {
// 			return;
// 		}

// 		let lastIndex: number;
// 		const entry: IFileStatus = {
// 			x: raw.charAt(i++),
// 			y: raw.charAt(i++),
// 			rename: undefined,
// 			path: ''
// 		};

// 		// space
// 		i++;

// 		if (entry.x === 'R' || entry.x === 'C') {
// 			lastIndex = raw.indexOf('\0', i);

// 			if (lastIndex === -1) {
// 				return;
// 			}

// 			entry.rename = raw.substring(i, lastIndex);
// 			i = lastIndex + 1;
// 		}

// 		lastIndex = raw.indexOf('\0', i);

// 		if (lastIndex === -1) {
// 			return;
// 		}

// 		entry.path = raw.substring(i, lastIndex);

// 		// If path ends with slash, it must be a nested bk repo
// 		if (entry.path[entry.path.length - 1] !== '/') {
// 			this.result.push(entry);
// 		}

// 		return lastIndex + 1;
// 	}
// }

export interface Submodule {
	name: string;
	path: string;
	url: string;
}

export function parseBkmodules(raw: string): Submodule[] {
	const regex = /\r?\n/g;
	let position = 0;
	let match: RegExpExecArray | null = null;

	const result: Submodule[] = [];
	let submodule: Partial<Submodule> = {};

	function parseLine(line: string): void {
		const sectionMatch = /^\s*\[submodule "([^"]+)"\]\s*$/.exec(line);

		if (sectionMatch) {
			if (submodule.name && submodule.path && submodule.url) {
				result.push(submodule as Submodule);
			}

			const name = sectionMatch[1];

			if (name) {
				submodule = { name };
				return;
			}
		}

		if (!submodule) {
			return;
		}

		const propertyMatch = /^\s*(\w+)\s*=\s*(.*)$/.exec(line);

		if (!propertyMatch) {
			return;
		}

		const [, key, value] = propertyMatch;

		switch (key) {
			case 'path': submodule.path = value; break;
			case 'url': submodule.url = value; break;
		}
	}

	while (match = regex.exec(raw)) {
		parseLine(raw.substring(position, match.index));
		position = match.index + match[0].length;
	}

	parseLine(raw.substring(position));

	if (submodule.name && submodule.path && submodule.url) {
		result.push(submodule as Submodule);
	}

	return result;
}

const commitRegex = /([0-9a-f]{40})\n(.*)\n(.*)\n(.*)\n(.*)\n(.*)\n(.*)(?:\n([^]*?))?(?:\x00)/gm;

export function parseBkCommits(data: string): Commit[] {
	const commits: Commit[] = [];

	let ref;
	let authorName;
	let authorEmail;
	let authorDate;
	let commitDate;
	let parents;
	let refNames;
	let message;
	let match;

	do {
		match = commitRegex.exec(data);
		if (match === null) {
			break;
		}

		[, ref, authorName, authorEmail, authorDate, commitDate, parents, refNames, message] = match;

		if (message[message.length - 1] === '\n') {
			message = message.substr(0, message.length - 1);
		}

		// Stop excessive memory usage by using substr -- https://bugs.chromium.org/p/v8/issues/detail?id=2869
		commits.push({
			hash: ` ${ref}`.substr(1),
			message: ` ${message}`.substr(1),
			parents: parents ? parents.split(' ') : [],
			authorDate: new Date(Number(authorDate) * 1000),
			authorName: ` ${authorName}`.substr(1),
			authorEmail: ` ${authorEmail}`.substr(1),
			commitDate: new Date(Number(commitDate) * 1000),
			refNames: refNames.split(',').map(s => s.trim())
		});
	} while (true);

	return commits;
}

interface LsTreeElement {
	mode: string;
	type: string;
	object: string;
	size: string;
	file: string;
}

export function parseLsTree(raw: string): LsTreeElement[] {
	return raw.split('\n')
		.filter(l => !!l)
		.map(line => /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line)!)
		.filter(m => !!m)
		.map(([, mode, type, object, size, file]) => ({ mode, type, object, size, file }));
}

interface LsFilesElement {
	mode: string;
	object: string;
	stage: string;
	file: string;
}

export function parseLsFiles(raw: string): LsFilesElement[] {
	return raw.split('\n')
		.filter(l => !!l)
		.map(line => /^(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line)!)
		.filter(m => !!m)
		.map(([, mode, object, stage, file]) => ({ mode, object, stage, file }));
}

export interface PullOptions {
	unshallow?: boolean;
	tags?: boolean;
	readonly cancellationToken?: CancellationToken;
}

export class Repository {

	constructor(
		private _bk: Bk,
		private repositoryRoot: string,
		readonly dotBk: { path: string; commonPath?: string }
	) { }

	get bk(): Bk {
		return this._bk;
	}

	get root(): string {
		return this.repositoryRoot;
	}

	async exec(args: string[], options: SpawnOptions = {}): Promise<IExecutionResult<string>> {
		return await this.bk.exec(this.repositoryRoot, args, options);
	}

	stream(args: string[], options: SpawnOptions = {}): cp.ChildProcess {
		return this.bk.stream(this.repositoryRoot, args, options);
	}

	spawn(args: string[], options: SpawnOptions = {}): cp.ChildProcess {
		return this.bk.spawn(args, options);
	}

	async config(scope: string, key: string, value: any = null, options: SpawnOptions = {}): Promise<string> {
		const args = ['config'];

		if (scope) {
			args.push('--' + scope);
		}

		args.push(key);

		if (value) {
			args.push(value);
		}

		const result = await this.exec(args, options);
		return result.stdout.trim();
	}

	async getConfigs(scope: string): Promise<{ key: string; value: string }[]> {
		const args = ['config'];

		if (scope) {
			args.push('--' + scope);
		}

		args.push('-l');

		const result = await this.exec(args);
		const lines = result.stdout.trim().split(/\r|\r\n|\n/);

		return lines.map(entry => {
			const equalsIndex = entry.indexOf('=');
			return { key: entry.substr(0, equalsIndex), value: entry.substr(equalsIndex + 1) };
		});
	}

	async log(options?: LogOptions): Promise<Commit[]> {
		const maxEntries = options?.maxEntries ?? 32;
		const args = ['log', `-${maxEntries}`, `--format=${COMMIT_FORMAT}`, '-z', '--'];
		if (options?.path) {
			args.push(options.path);
		}

		const result = await this.exec(args);
		if (result.exitCode) {
			// An empty repo
			return [];
		}

		return parseBkCommits(result.stdout);
	}

	async logFile(uri: Uri, options?: LogFileOptions): Promise<Commit[]> {
		const args = ['log', `--format=${COMMIT_FORMAT}`, '-z'];

		if (options?.maxEntries && !options?.reverse) {
			args.push(`-n${options.maxEntries}`);
		}

		if (options?.hash) {
			// If we are reversing, we must add a range (with HEAD) because we are using --ancestry-path for better reverse walking
			if (options?.reverse) {
				args.push('--reverse', '--ancestry-path', `${options.hash}..HEAD`);
			} else {
				args.push(options.hash);
			}
		}

		if (options?.sortByAuthorDate) {
			args.push('--author-date-order');
		}

		args.push('--', uri.fsPath);

		const result = await this.exec(args);
		if (result.exitCode) {
			// No file history, e.g. a new file or untracked
			return [];
		}

		return parseBkCommits(result.stdout);
	}

	async bufferString(object: string, encoding: string = 'utf8', autoGuessEncoding = false): Promise<string> {
		const stdout = await this.buffer(object);

		if (autoGuessEncoding) {
			encoding = detectEncoding(stdout) || encoding;
		}

		encoding = iconv.encodingExists(encoding) ? encoding : 'utf8';

		return iconv.decode(stdout, encoding);
	}

	async buffer(object: string): Promise<Buffer> {
		const child = this.stream(['show', '--textconv', object]);

		if (!child.stdout) {
			return Promise.reject<Buffer>('Can\'t open file from bk');
		}

		const { exitCode, stdout, stderr } = await exec(child);

		if (exitCode) {
			const err = new BkError({
				message: 'Could not show object.',
				exitCode
			});

			if (/exists on disk, but not in/.test(stderr)) {
				err.bkErrorCode = BkErrorCodes.WrongCase;
			}

			return Promise.reject<Buffer>(err);
		}

		return stdout;
	}

	async getObjectDetails(treeish: string, path: string): Promise<{ mode: string; object: string; size: number }> {
		if (!treeish) { // index
			const elements = await this.lsfiles(path);

			if (elements.length === 0) {
				throw new BkError({ message: 'Path not known by bk', bkErrorCode: BkErrorCodes.UnknownPath });
			}

			const { mode, object } = elements[0];
			const catFile = await this.exec(['cat-file', '-s', object]);
			const size = parseInt(catFile.stdout);

			return { mode, object, size };
		}

		const elements = await this.lstree(treeish, path);

		if (elements.length === 0) {
			throw new BkError({ message: 'Path not known by bk', bkErrorCode: BkErrorCodes.UnknownPath });
		}

		const { mode, object, size } = elements[0];
		return { mode, object, size: parseInt(size) };
	}

	async lstree(treeish: string, path: string): Promise<LsTreeElement[]> {
		const { stdout } = await this.exec(['ls-tree', '-l', treeish, '--', sanitizePath(path)]);
		return parseLsTree(stdout);
	}

	async lsfiles(path: string): Promise<LsFilesElement[]> {
		const { stdout } = await this.exec(['ls-files', '--stage', '--', sanitizePath(path)]);
		return parseLsFiles(stdout);
	}

	async getBkRelativePath(ref: string, relativePath: string): Promise<string> {
		const relativePathLowercase = relativePath.toLowerCase();
		const dirname = path.posix.dirname(relativePath) + '/';
		const elements: { file: string }[] = ref ? await this.lstree(ref, dirname) : await this.lsfiles(dirname);
		const element = elements.filter(file => file.file.toLowerCase() === relativePathLowercase)[0];

		if (!element) {
			throw new BkError({ message: 'Bk relative path not found.' });
		}

		return element.file;
	}

	async detectObjectType(object: string): Promise<{ mimetype: string; encoding?: string }> {
		const child = await this.stream(['show', '--textconv', object]);
		const buffer = await readBytes(child.stdout!, 4100);

		try {
			child.kill();
		} catch (err:any) {
			// noop
		}

		const encoding = detectUnicodeEncoding(buffer);
		let isText = true;

		if (encoding !== Encoding.UTF16be && encoding !== Encoding.UTF16le) {
			for (let i = 0; i < buffer.length; i++) {
				if (buffer.readInt8(i) === 0) {
					isText = false;
					break;
				}
			}
		}

		if (!isText) {
			const result = await filetype.fromBuffer(buffer);

			if (!result) {
				return { mimetype: 'application/octet-stream' };
			} else {
				return { mimetype: result.mime };
			}
		}

		if (encoding) {
			return { mimetype: 'text/plain', encoding };
		} else {
			// TODO@JOAO: read the setting OUTSIDE!
			return { mimetype: 'text/plain' };
		}
	}

	async apply(patch: string, reverse?: boolean): Promise<void> {
		const args = ['apply', patch];

		if (reverse) {
			args.push('-R');
		}

		try {
			await this.exec(args);
		} catch (err: any) {
			if (/patch does not apply/.test(err.stderr)) {
				err.bkErrorCode = BkErrorCodes.PatchDoesNotApply;
			}

			throw err;
		}
	}

	async diff(cached = false): Promise<string> {
		const args = ['diff'];

		if (cached) {
			args.push('--cached');
		}

		const result = await this.exec(args);
		return result.stdout;
	}

	diffWithHEAD(): Promise<Change[]>;
	diffWithHEAD(path: string): Promise<string>;
	diffWithHEAD(path?: string | undefined): Promise<string | Change[]>;
	async diffWithHEAD(path?: string | undefined): Promise<string | Change[]> {
		if (!path) {
			return await this.diffFiles(false);
		}

		const args = ['diff', '--', sanitizePath(path)];
		const result = await this.exec(args);
		return result.stdout;
	}

	diffWith(ref: string): Promise<Change[]>;
	diffWith(ref: string, path: string): Promise<string>;
	diffWith(ref: string, path?: string | undefined): Promise<string | Change[]>;
	async diffWith(ref: string, path?: string): Promise<string | Change[]> {
		if (!path) {
			return await this.diffFiles(false, ref);
		}

		const args = ['diff', ref, '--', sanitizePath(path)];
		const result = await this.exec(args);
		return result.stdout;
	}

	diffIndexWithHEAD(): Promise<Change[]>;
	diffIndexWithHEAD(path: string): Promise<string>;
	diffIndexWithHEAD(path?: string | undefined): Promise<string | Change[]>;
	async diffIndexWithHEAD(path?: string): Promise<string | Change[]> {
		if (!path) {
			return await this.diffFiles(true);
		}

		const args = ['diff', '--cached', '--', sanitizePath(path)];
		const result = await this.exec(args);
		return result.stdout;
	}

	diffIndexWith(ref: string): Promise<Change[]>;
	diffIndexWith(ref: string, path: string): Promise<string>;
	diffIndexWith(ref: string, path?: string | undefined): Promise<string | Change[]>;
	async diffIndexWith(ref: string, path?: string): Promise<string | Change[]> {
		if (!path) {
			return await this.diffFiles(true, ref);
		}

		const args = ['diff', '--cached', ref, '--', sanitizePath(path)];
		const result = await this.exec(args);
		return result.stdout;
	}

	async diffBlobs(object1: string, object2: string): Promise<string> {
		const args = ['diff', object1, object2];
		const result = await this.exec(args);
		return result.stdout;
	}

	diffBetween(ref1: string, ref2: string): Promise<Change[]>;
	diffBetween(ref1: string, ref2: string, path: string): Promise<string>;
	diffBetween(ref1: string, ref2: string, path?: string | undefined): Promise<string | Change[]>;
	async diffBetween(ref1: string, ref2: string, path?: string): Promise<string | Change[]> {
		const range = `${ref1}...${ref2}`;
		if (!path) {
			return await this.diffFiles(false, range);
		}

		const args = ['diff', range, '--', sanitizePath(path)];
		const result = await this.exec(args);

		return result.stdout.trim();
	}

	private async diffFiles(cached: boolean, ref?: string): Promise<Change[]> {
		const args = ['diff', '--name-status', '-z', '--diff-filter=ADMR'];
		if (cached) {
			args.push('--cached');
		}

		if (ref) {
			args.push(ref);
		}

		const bkResult = await this.exec(args);
		if (bkResult.exitCode) {
			return [];
		}

		const entries = bkResult.stdout.split('\x00');
		let index = 0;
		const result: Change[] = [];

		entriesLoop:
		while (index < entries.length - 1) {
			const change = entries[index++];
			const resourcePath = entries[index++];
			if (!change || !resourcePath) {
				break;
			}

			const originalUri = Uri.file(path.isAbsolute(resourcePath) ? resourcePath : path.join(this.repositoryRoot, resourcePath));
			let status: Status = Status.UNTRACKED;

			// Copy or Rename status comes with a number, e.g. 'R100'. We don't need the number, so we use only first character of the status.
			switch (change[0]) {
				case 'M':
					status = Status.MODIFIED;
					break;

				case 'A':
					status = Status.INDEX_ADDED;
					break;

				case 'D':
					status = Status.DELETED;
					break;

				// Rename contains two paths, the second one is what the file is renamed/copied to.
				case 'R': {
					if (index >= entries.length) {
						break;
					}

					const newPath = entries[index++];
					if (!newPath) {
						break;
					}

					const uri = Uri.file(path.isAbsolute(newPath) ? newPath : path.join(this.repositoryRoot, newPath));
					result.push({
						uri,
						renameUri: uri,
						originalUri,
						status: Status.INDEX_RENAMED
					});

					continue;
				}
				default:
					// Unknown status
					break entriesLoop;
			}

			result.push({
				status,
				originalUri,
				uri: originalUri,
				renameUri: originalUri,
			});
		}

		return result;
	}

	async getMergeBase(ref1: string, ref2: string): Promise<string> {
		const args = ['merge-base', ref1, ref2];
		const result = await this.exec(args);

		return result.stdout.trim();
	}

	async hashObject(data: string): Promise<string> {
		const args = ['hash-object', '-w', '--stdin'];
		const result = await this.exec(args, { input: data });

		return result.stdout.trim();
	}

	async add(paths: string[], opts?: { update?: boolean }): Promise<void> {
		const args = ['add'];

		if (opts && opts.update) {
			args.push('-u');
		} else {
			args.push('-A');
		}

		if (paths && paths.length) {
			for (const chunk of splitInChunks(paths.map(sanitizePath), MAX_CLI_LENGTH)) {
				await this.exec([...args, '--', ...chunk]);
			}
		} else {
			await this.exec([...args, '--', '.']);
		}
	}

	async rm(paths: string[]): Promise<void> {
		const args = ['rm', '--'];

		if (!paths || !paths.length) {
			return;
		}

		args.push(...paths.map(sanitizePath));

		await this.exec(args);
	}

	async stage(path: string, data: string): Promise<void> {
		const child = this.stream(['hash-object', '--stdin', '-w', '--path', sanitizePath(path)], { stdio: [null, null, null] });
		child.stdin!.end(data, 'utf8');

		const { exitCode, stdout } = await exec(child);
		const hash = stdout.toString('utf8');

		if (exitCode) {
			throw new BkError({
				message: 'Could not hash object.',
				exitCode: exitCode
			});
		}

		const treeish = await this.getCommit('HEAD').then(() => 'HEAD', () => '');
		let mode: string;
		let add: string = '';

		try {
			const details = await this.getObjectDetails(treeish, path);
			mode = details.mode;
		} catch (err: any) {
			if (err.bkErrorCode !== BkErrorCodes.UnknownPath) {
				throw err;
			}

			mode = '100644';
			add = '--add';
		}

		await this.exec(['update-index', add, '--cacheinfo', mode, hash, path]);
	}

	async checkout(treeish: string, paths: string[], opts: { track?: boolean; detached?: boolean } = Object.create(null)): Promise<void> {
		const args = ['checkout', '-q'];

		if (opts.track) {
			args.push('--track');
		}

		if (opts.detached) {
			args.push('--detach');
		}

		if (treeish) {
			args.push(treeish);
		}

		try {
			if (paths && paths.length > 0) {
				for (const chunk of splitInChunks(paths.map(sanitizePath), MAX_CLI_LENGTH)) {
					await this.exec([...args, '--', ...chunk]);
				}
			} else {
				await this.exec(args);
			}
		} catch (err: any) {
			if (/Please,? commit your changes or stash them/.test(err.stderr || '')) {
				err.bkErrorCode = BkErrorCodes.DirtyWorkTree;
				err.bkTreeish = treeish;
			}

			throw err;
		}
	}

	async commit(message: string | undefined, opts: CommitOptions = Object.create(null)): Promise<void> {
		const args = ['commit', '--quiet'];
		const options: SpawnOptions = {};

		if (message) {
			options.input = message;
			args.push('--allow-empty-message', '--file', '-');
		}

		if (opts.verbose) {
			args.push('--verbose');
		}

		if (opts.all) {
			args.push('--all');
		}

		if (opts.amend) {
			args.push('--amend');
		}

		if (!opts.useEditor) {
			if (!message) {
				if (opts.amend) {
					args.push('--no-edit');
				} else {
					options.input = '';
					args.push('--file', '-');
				}
			}

			args.push('--allow-empty-message');
		}

		if (opts.signoff) {
			args.push('--signoff');
		}

		if (opts.signCommit) {
			args.push('-S');
		}

		if (opts.empty) {
			args.push('--allow-empty');
		}

		if (opts.noVerify) {
			args.push('--no-verify');
		}

		if (opts.requireUserConfig ?? true) {
			// Stops bk from guessing at user/email
			args.splice(0, 0, '-c', 'user.useConfigOnly=true');
		}

		try {
			await this.exec(args, options);
		} catch (commitErr) {
			await this.handleCommitError(commitErr);
		}
	}

	async rebaseAbort(): Promise<void> {
		await this.exec(['rebase', '--abort']);
	}

	async rebaseContinue(): Promise<void> {
		const args = ['rebase', '--continue'];

		try {
			await this.exec(args, { env: { GIT_EDITOR: 'true' } });
		} catch (commitErr) {
			await this.handleCommitError(commitErr);
		}
	}

	private async handleCommitError(commitErr: any): Promise<void> {
		if (/not possible because you have unmerged files/.test(commitErr.stderr || '')) {
			commitErr.bkErrorCode = BkErrorCodes.UnmergedChanges;
			throw commitErr;
		} else if (/Aborting commit due to empty commit message/.test(commitErr.stderr || '')) {
			commitErr.bkErrorCode = BkErrorCodes.EmptyCommitMessage;
			throw commitErr;
		}

		try {
			await this.exec(['config', '--get-all', 'user.name']);
		} catch (err: any) {
			err.bkErrorCode = BkErrorCodes.NoUserNameConfigured;
			throw err;
		}

		try {
			await this.exec(['config', '--get-all', 'user.email']);
		} catch (err: any) {
			err.bkErrorCode = BkErrorCodes.NoUserEmailConfigured;
			throw err;
		}

		throw commitErr;
	}

	async branch(name: string, checkout: boolean, ref?: string): Promise<void> {
		const args = checkout ? ['checkout', '-q', '-b', name, '--no-track'] : ['branch', '-q', name];

		if (ref) {
			args.push(ref);
		}

		await this.exec(args);
	}

	async deleteBranch(name: string, force?: boolean): Promise<void> {
		const args = ['branch', force ? '-D' : '-d', name];
		await this.exec(args);
	}

	async renameBranch(name: string): Promise<void> {
		const args = ['branch', '-m', name];
		await this.exec(args);
	}

	async move(from: string, to: string): Promise<void> {
		const args = ['mv', from, to];
		await this.exec(args);
	}

	async setBranchUpstream(name: string, upstream: string): Promise<void> {
		const args = ['branch', '--set-upstream-to', upstream, name];
		await this.exec(args);
	}

	async deleteRef(ref: string): Promise<void> {
		const args = ['update-ref', '-d', ref];
		await this.exec(args);
	}

	async merge(ref: string): Promise<void> {
		const args = ['merge', ref];

		try {
			await this.exec(args);
		} catch (err: any) {
			if (/^CONFLICT /m.test(err.stdout || '')) {
				err.bkErrorCode = BkErrorCodes.Conflict;
			}

			throw err;
		}
	}

	async tag(name: string, message?: string): Promise<void> {
		let args = ['tag'];

		if (message) {
			args = [...args, '-a', name, '-m', message];
		} else {
			args = [...args, name];
		}

		await this.exec(args);
	}

	async deleteTag(name: string): Promise<void> {
		const args = ['tag', '-d', name];
		await this.exec(args);
	}

	async clean(paths: string[]): Promise<void> {
		const pathsByGroup = groupBy(paths.map(sanitizePath), p => path.dirname(p));
		const groups = Object.keys(pathsByGroup).map(k => pathsByGroup[k]);

		const limiter = new Limiter(5);
		const promises: Promise<any>[] = [];
		const args = ['clean', '-f', '-q'];

		for (const paths of groups) {
			for (const chunk of splitInChunks(paths.map(sanitizePath), MAX_CLI_LENGTH)) {
				promises.push(limiter.queue(() => this.exec([...args, '--', ...chunk])));
			}
		}

		await Promise.all(promises);
	}

	async undo(): Promise<void> {
		await this.exec(['clean', '-fd']);

		try {
			await this.exec(['checkout', '--', '.']);
		} catch (err:any) {
			if (/did not match any file\(s\) known to bk\./.test(err.stderr || '')) {
				return;
			}

			throw err;
		}
	}

	async reset(treeish: string, hard: boolean = false): Promise<void> {
		const args = ['reset', hard ? '--hard' : '--soft', treeish];
		await this.exec(args);
	}

	async revert(treeish: string, paths: string[]): Promise<void> {
		const result = await this.exec(['branch']);
		let args: string[];

		// In case there are no branches, we must use rm --cached
		if (!result.stdout) {
			args = ['rm', '--cached', '-r'];
		} else {
			args = ['reset', '-q', treeish];
		}

		try {
			if (paths && paths.length > 0) {
				for (const chunk of splitInChunks(paths.map(sanitizePath), MAX_CLI_LENGTH)) {
					await this.exec([...args, '--', ...chunk]);
				}
			} else {
				await this.exec([...args, '--', '.']);
			}
		} catch (err:any) {
			// In case there are merge conflicts to be resolved, bk reset will output
			// some "needs merge" data. We try to get around that.
			if (/([^:]+: needs merge\n)+/m.test(err.stdout || '')) {
				return;
			}

			throw err;
		}
	}

	async addRemote(name: string, url: string): Promise<void> {
		const args = ['remote', 'add', name, url];
		await this.exec(args);
	}

	async removeRemote(name: string): Promise<void> {
		const args = ['remote', 'remove', name];
		await this.exec(args);
	}

	async renameRemote(name: string, newName: string): Promise<void> {
		const args = ['remote', 'rename', name, newName];
		await this.exec(args);
	}

	async fetch(options: { remote?: string; ref?: string; all?: boolean; prune?: boolean; depth?: number; silent?: boolean; readonly cancellationToken?: CancellationToken } = {}): Promise<void> {
		const args = ['fetch'];
		const spawnOptions: SpawnOptions = {
			cancellationToken: options.cancellationToken,
			env: { 'GIT_HTTP_USER_AGENT': this.bk.userAgent }
		};

		if (options.remote) {
			args.push(options.remote);

			if (options.ref) {
				args.push(options.ref);
			}
		} else if (options.all) {
			args.push('--all');
		}

		if (options.prune) {
			args.push('--prune');
		}

		if (typeof options.depth === 'number') {
			args.push(`--depth=${options.depth}`);
		}

		if (options.silent) {
			spawnOptions.env!['VSCODE_GIT_FETCH_SILENT'] = 'true';
		}

		try {
			await this.exec(args, spawnOptions);
		} catch (err:any) {
			if (/No remote repository specified\./.test(err.stderr || '')) {
				err.bkErrorCode = BkErrorCodes.NoRemoteRepositorySpecified;
			} else if (/Could not read from remote repository/.test(err.stderr || '')) {
				err.bkErrorCode = BkErrorCodes.RemoteConnectionError;
			}

			throw err;
		}
	}

	async pull(rebase?: boolean, remote?: string, branch?: string, options: PullOptions = {}): Promise<void> {
		const args = ['pull'];

		if (options.tags) {
			args.push('--tags');
		}

		if (options.unshallow) {
			args.push('--unshallow');
		}

		if (rebase) {
			args.push('-r');
		}

		if (remote && branch) {
			args.push(remote);
			args.push(branch);
		}

		try {
			await this.exec(args, {
				cancellationToken: options.cancellationToken,
				env: { 'GIT_HTTP_USER_AGENT': this.bk.userAgent }
			});
		} catch (err:any) {
			if (/^CONFLICT \([^)]+\): \b/m.test(err.stdout || '')) {
				err.bkErrorCode = BkErrorCodes.Conflict;
			} else if (/Please tell me who you are\./.test(err.stderr || '')) {
				err.bkErrorCode = BkErrorCodes.NoUserNameConfigured;
			} else if (/Could not read from remote repository/.test(err.stderr || '')) {
				err.bkErrorCode = BkErrorCodes.RemoteConnectionError;
			} else if (/Pull(?:ing)? is not possible because you have unmerged files|Cannot pull with rebase: You have unstaged changes|Your local changes to the following files would be overwritten|Please, commit your changes before you can merge/i.test(err.stderr)) {
				err.stderr = err.stderr.replace(/Cannot pull with rebase: You have unstaged changes/i, 'Cannot pull with rebase, you have unstaged changes');
				err.bkErrorCode = BkErrorCodes.DirtyWorkTree;
			} else if (/cannot lock ref|unable to update local ref/i.test(err.stderr || '')) {
				err.bkErrorCode = BkErrorCodes.CantLockRef;
			} else if (/cannot rebase onto multiple branches/i.test(err.stderr || '')) {
				err.bkErrorCode = BkErrorCodes.CantRebaseMultipleBranches;
			}

			throw err;
		}
	}

	async rebase(branch: string, options: PullOptions = {}): Promise<void> {
		const args = ['rebase'];

		args.push(branch);

		try {
			await this.exec(args, options);
		} catch (err:any) {
			if (/^CONFLICT \([^)]+\): \b/m.test(err.stdout || '')) {
				err.bkErrorCode = BkErrorCodes.Conflict;
			} else if (/cannot rebase onto multiple branches/i.test(err.stderr || '')) {
				err.bkErrorCode = BkErrorCodes.CantRebaseMultipleBranches;
			}

			throw err;
		}
	}

	async push(remote?: string, name?: string, setUpstream: boolean = false, followTags = false, forcePushMode?: ForcePushMode, tags = false): Promise<void> {
		const args = ['push'];

		if (forcePushMode === ForcePushMode.ForceWithLease) {
			args.push('--force-with-lease');
		} else if (forcePushMode === ForcePushMode.Force) {
			args.push('--force');
		}

		if (setUpstream) {
			args.push('-u');
		}

		if (followTags) {
			args.push('--follow-tags');
		}

		if (tags) {
			args.push('--tags');
		}

		if (remote) {
			args.push(remote);
		}

		if (name) {
			args.push(name);
		}

		try {
			await this.exec(args, { env: { 'GIT_HTTP_USER_AGENT': this.bk.userAgent } });
		} catch (err:any) {
			if (/^error: failed to push some refs to\b/m.test(err.stderr || '')) {
				err.bkErrorCode = BkErrorCodes.PushRejected;
			} else if (/Permission.*denied/.test(err.stderr || '')) {
				err.bkErrorCode = BkErrorCodes.PermissionDenied;
			} else if (/Could not read from remote repository/.test(err.stderr || '')) {
				err.bkErrorCode = BkErrorCodes.RemoteConnectionError;
			} else if (/^fatal: The current branch .* has no upstream branch/.test(err.stderr || '')) {
				err.bkErrorCode = BkErrorCodes.NoUpstreamBranch;
			}

			throw err;
		}
	}

	async cherryPick(commitHash: string): Promise<void> {
		const args = ['cherry-pick', commitHash];
		await this.exec(args);
	}

	async blame(path: string): Promise<string> {
		try {
			const args = ['blame', sanitizePath(path)];
			const result = await this.exec(args);
			return result.stdout.trim();
		} catch (err:any) {
			if (/^fatal: no such path/.test(err.stderr || '')) {
				err.bkErrorCode = BkErrorCodes.NoPathFound;
			}

			throw err;
		}
	}

	async createStash(message?: string, includeUntracked?: boolean): Promise<void> {
		try {
			const args = ['stash', 'push'];

			if (includeUntracked) {
				args.push('-u');
			}

			if (message) {
				args.push('-m', message);
			}

			await this.exec(args);
		} catch (err:any) {
			if (/No local changes to save/.test(err.stderr || '')) {
				err.bkErrorCode = BkErrorCodes.NoLocalChanges;
			}

			throw err;
		}
	}

	async popStash(index?: number): Promise<void> {
		const args = ['stash', 'pop'];
		await this.popOrApplyStash(args, index);
	}

	async applyStash(index?: number): Promise<void> {
		const args = ['stash', 'apply'];
		await this.popOrApplyStash(args, index);
	}

	private async popOrApplyStash(args: string[], index?: number): Promise<void> {
		try {
			if (typeof index === 'number') {
				args.push(`stash@{${index}}`);
			}

			await this.exec(args);
		} catch (err:any) {
			if (/No stash found/.test(err.stderr || '')) {
				err.bkErrorCode = BkErrorCodes.NoStashFound;
			} else if (/error: Your local changes to the following files would be overwritten/.test(err.stderr || '')) {
				err.bkErrorCode = BkErrorCodes.LocalChangesOverwritten;
			} else if (/^CONFLICT/m.test(err.stdout || '')) {
				err.bkErrorCode = BkErrorCodes.StashConflict;
			}

			throw err;
		}
	}

	async dropStash(index?: number): Promise<void> {
		const args = ['stash'];

		if (typeof index === 'number') {
			args.push('drop');
			args.push(`stash@{${index}}`);
		} else {
			args.push('clear');
		}

		try {
			await this.exec(args);
		} catch (err:any) {
			if (/No stash found/.test(err.stderr || '')) {
				err.bkErrorCode = BkErrorCodes.NoStashFound;
			}

			throw err;
		}
	}

	getStatus(opts?: { limit?: number; ignoreSubmodules?: boolean; untrackedChanges?: 'mixed' | 'separate' | 'hidden' }): Promise<{ status: IFileStatus[]; statusLength: number; didHitLimit: boolean }> {
		return new Promise<{ status: IFileStatus[]; statusLength: number; didHitLimit: boolean }>((c, e) => {
			const parser = new BkStatusParser();
			const env = { GIT_OPTIONAL_LOCKS: '0' };
			const args = ['gfiles', '-0' , '-cgxvp'];

			// if (opts?.untrackedChanges === 'hidden') {
			// 	args.push('-uno');
			// } else {
			// 	args.push('-uall');
			// }

			// if (opts?.ignoreSubmodules) {
			// 	args.push('--ignore-submodules');
			// }

			const child = this.stream(args, { env });

			const onExit = (exitCode: number) => {
				if (exitCode !== 0) {
					const stderr = stderrData.join('');
					return e(new BkError({
						message: 'Failed to execute bk',
						stderr,
						exitCode,
						bkErrorCode: getBkErrorCode(stderr),
						bkCommand: 'status',
						bkArgs: args
					}));
				}

				c({ status: parser.status, statusLength: parser.status.length, didHitLimit: false });
			};

			const limit = opts?.limit ?? 10000;
			const onStdoutData = (raw: string) => {
				parser.update(raw);

				if (limit !== 0 && parser.status.length > limit) {
					child.removeListener('exit', onExit);
					child.stdout!.removeListener('data', onStdoutData);
					child.kill();

					c({ status: parser.status.slice(0, limit), statusLength: parser.status.length, didHitLimit: true });
				}
			};

			child.stdout!.setEncoding('utf8');
			child.stdout!.on('data', onStdoutData);

			const stderrData: string[] = [];
			child.stderr!.setEncoding('utf8');
			child.stderr!.on('data', raw => stderrData.push(raw as string));

			child.on('error', cpErrorHandler(e));
			child.on('exit', onExit);
		});
	}

	async getHEAD(): Promise<Ref> {
		try {
			const result = await this.exec(['symbolic-ref', '--short', 'HEAD']);

			if (!result.stdout) {
				throw new Error('Not in a branch');
			}

			return { name: result.stdout.trim(), commit: undefined, type: RefType.Head };
		} catch (err:any) {
			const result = await this.exec(['rev-parse', 'HEAD']);

			if (!result.stdout) {
				throw new Error('Error parsing HEAD');
			}

			return { name: undefined, commit: result.stdout.trim(), type: RefType.Head };
		}
	}

	async findTrackingBranches(upstreamBranch: string): Promise<Branch[]> {
		const result = await this.exec(['for-each-ref', '--format', '%(refname:short)%00%(upstream:short)', 'refs/heads']);
		return result.stdout.trim().split('\n')
			.map(line => line.trim().split('\0'))
			.filter(([_, upstream]) => upstream === upstreamBranch)
			.map(([ref]) => ({ name: ref, type: RefType.Head } as Branch));
	}

	async getRefs(opts?: { sort?: 'alphabetically' | 'committerdate'; contains?: string; pattern?: string; count?: number }): Promise<Ref[]> {
		const args = ['for-each-ref'];

		if (opts?.count) {
			args.push(`--count=${opts.count}`);
		}

		if (opts && opts.sort && opts.sort !== 'alphabetically') {
			args.push('--sort', `-${opts.sort}`);
		}

		args.push('--format', '%(refname) %(objectname) %(*objectname)');

		if (opts?.pattern) {
			args.push(opts.pattern);
		}

		if (opts?.contains) {
			args.push('--contains', opts.contains);
		}

		const result = await this.exec(args);

		const fn = (line: string): Ref | null => {
			let match: RegExpExecArray | null;

			if (match = /^refs\/heads\/([^ ]+) ([0-9a-f]{40}) ([0-9a-f]{40})?$/.exec(line)) {
				return { name: match[1], commit: match[2], type: RefType.Head };
			} else if (match = /^refs\/remotes\/([^/]+)\/([^ ]+) ([0-9a-f]{40}) ([0-9a-f]{40})?$/.exec(line)) {
				return { name: `${match[1]}/${match[2]}`, commit: match[3], type: RefType.RemoteHead, remote: match[1] };
			} else if (match = /^refs\/tags\/([^ ]+) ([0-9a-f]{40}) ([0-9a-f]{40})?$/.exec(line)) {
				return { name: match[1], commit: match[3] ?? match[2], type: RefType.Tag };
			}

			return null;
		};

		return result.stdout.split('\n')
			.filter(line => !!line)
			.map(fn)
			.filter(ref => !!ref) as Ref[];
	}

	async getStashes(): Promise<Stash[]> {
		const result = await this.exec(['stash', 'list']);
		const regex = /^stash@{(\d+)}:(.+)$/;
		const rawStashes = result.stdout.trim().split('\n')
			.filter(b => !!b)
			.map(line => regex.exec(line) as RegExpExecArray)
			.filter(g => !!g)
			.map(([, index, description]: RegExpExecArray) => ({ index: parseInt(index), description }));

		return rawStashes;
	}

	// async getRemotes(): Promise<Remote[]> {
	// 	const result = await this.exec(['remote', '--verbose']);
	// 	const lines = result.stdout.trim().split('\n').filter(l => !!l);
	// 	const remotes: MutableRemote[] = [];

	// 	for (const line of lines) {
	// 		const parts = line.split(/\s/);
	// 		const [name, url, type] = parts;

	// 		let remote = remotes.find(r => r.name === name);

	// 		if (!remote) {
	// 			remote = { name, isReadOnly: false };
	// 			remotes.push(remote);
	// 		}

	// 		if (/fetch/i.test(type)) {
	// 			remote.fetchUrl = url;
	// 		} else if (/push/i.test(type)) {
	// 			remote.pushUrl = url;
	// 		} else {
	// 			remote.fetchUrl = url;
	// 			remote.pushUrl = url;
	// 		}

	// 		// https://bkhub.com/microsoft/vscode/issues/45271
	// 		remote.isReadOnly = remote.pushUrl === undefined || remote.pushUrl === 'no_push';
	// 	}

	// 	return remotes;
	// }

	async getBranch(name: string): Promise<Branch> {
		if (name === 'HEAD') {
			return this.getHEAD();
		}

		const args = ['for-each-ref'];

		let supportsAheadBehind = true;
		if (this._bk.compareBkVersionTo('1.9.0') === -1) {
			args.push('--format=%(refname)%00%(upstream:short)%00%(objectname)');
			supportsAheadBehind = false;
		} else if (this._bk.compareBkVersionTo('2.16.0') === -1) {
			args.push('--format=%(refname)%00%(upstream:short)%00%(objectname)%00%(upstream:track)');
		} else {
			args.push('--format=%(refname)%00%(upstream:short)%00%(objectname)%00%(upstream:track)%00%(upstream:remotename)%00%(upstream:remoteref)');
		}

		if (/^refs\/(head|remotes)\//i.test(name)) {
			args.push(name);
		} else {
			args.push(`refs/heads/${name}`, `refs/remotes/${name}`);
		}

		const result = await this.exec(args);
		const branches: Branch[] = result.stdout.trim().split('\n').map<Branch | undefined>(line => {
			let [branchName, upstream, ref, status, remoteName, upstreamRef] = line.trim().split('\0');

			if (branchName.startsWith('refs/heads/')) {
				branchName = branchName.substring(11);
				const index = upstream.indexOf('/');

				let ahead;
				let behind;
				const match = /\[(?:ahead ([0-9]+))?[,\s]*(?:behind ([0-9]+))?]|\[gone]/.exec(status);
				if (match) {
					[, ahead, behind] = match;
				}

				return {
					type: RefType.Head,
					name: branchName,
					upstream: upstream ? {
						name: upstreamRef ? upstreamRef.substring(11) : upstream.substring(index + 1),
						remote: remoteName ? remoteName : upstream.substring(0, index)
					} : undefined,
					commit: ref || undefined,
					ahead: Number(ahead) || 0,
					behind: Number(behind) || 0,
				};
			} else if (branchName.startsWith('refs/remotes/')) {
				branchName = branchName.substring(13);
				const index = branchName.indexOf('/');

				return {
					type: RefType.RemoteHead,
					name: branchName.substring(index + 1),
					remote: branchName.substring(0, index),
					commit: ref,
				};
			} else {
				return undefined;
			}
		}).filter((b?: Branch): b is Branch => !!b);

		if (branches.length) {
			const [branch] = branches;

			if (!supportsAheadBehind && branch.upstream) {
				try {
					const result = await this.exec(['rev-list', '--left-right', '--count', `${branch.name}...${branch.upstream.remote}/${branch.upstream.name}`]);
					const [ahead, behind] = result.stdout.trim().split('\t');

					(branch as any).ahead = Number(ahead) || 0;
					(branch as any).behind = Number(behind) || 0;
				} catch { }
			}

			return branch;
		}

		return Promise.reject<Branch>(new Error('No such branch'));
	}

	async getBranches(query: BranchQuery): Promise<Ref[]> {
		const refs = await this.getRefs({ contains: query.contains, pattern: query.pattern ? `refs/${query.pattern}` : undefined, count: query.count });
		return refs.filter(value => (value.type !== RefType.Tag) && (query.remote || !value.remote));
	}

	// TODO: Support core.commentChar
	stripCommitMessageComments(message: string): string {
		return message.replace(/^\s*#.*$\n?/gm, '').trim();
	}

	async getSquashMessage(): Promise<string | undefined> {
		const squashMsgPath = path.join(this.repositoryRoot, '.bk', 'SQUASH_MSG');

		try {
			const raw = await fs.readFile(squashMsgPath, 'utf8');
			return this.stripCommitMessageComments(raw);
		} catch {
			return undefined;
		}
	}

	async getMergeMessage(): Promise<string | undefined> {
		const mergeMsgPath = path.join(this.repositoryRoot, '.bk', 'MERGE_MSG');

		try {
			const raw = await fs.readFile(mergeMsgPath, 'utf8');
			return this.stripCommitMessageComments(raw);
		} catch {
			return undefined;
		}
	}

	async getCommitTemplate(): Promise<string> {
		try {
			const result = await this.exec(['config', '--get', 'commit.template']);

			if (!result.stdout) {
				return '';
			}

			// https://bkhub.com/bk/bk/blob/3a0f269e7c82aa3a87323cb7ae04ac5f129f036b/path.c#L612
			const homedir = os.homedir();
			let templatePath = result.stdout.trim()
				.replace(/^~([^\/]*)\//, (_, user) => `${user ? path.join(path.dirname(homedir), user) : homedir}/`);

			if (!path.isAbsolute(templatePath)) {
				templatePath = path.join(this.repositoryRoot, templatePath);
			}

			const raw = await fs.readFile(templatePath, 'utf8');
			return this.stripCommitMessageComments(raw);
		} catch (err:any) {
			return '';
		}
	}

	async getCommit(ref: string): Promise<Commit> {
		const result = await this.exec(['show', '-s', `--format=${COMMIT_FORMAT}`, '-z', ref]);
		const commits = parseBkCommits(result.stdout);
		if (commits.length === 0) {
			return Promise.reject<Commit>('bad commit format');
		}
		return commits[0];
	}

	async updateSubmodules(paths: string[]): Promise<void> {
		const args = ['submodule', 'update'];

		for (const chunk of splitInChunks(paths.map(sanitizePath), MAX_CLI_LENGTH)) {
			await this.exec([...args, '--', ...chunk]);
		}
	}

	async getSubmodules(): Promise<Submodule[]> {
		const bkmodulesPath = path.join(this.root, '.bkmodules');

		try {
			const bkmodulesRaw = await fs.readFile(bkmodulesPath, 'utf8');
			return parseBkmodules(bkmodulesRaw);
		} catch (err:any) {
			if (/ENOENT/.test(err.message)) {
				return [];
			}

			throw err;
		}
	}
}
