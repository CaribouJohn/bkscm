import * as nls from 'vscode-nls';
const localize = nls.loadMessageBundle();

// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { commands, Disposable, env, ExtensionContext, Uri, window, workspace } from 'vscode';
import { Bk, findBk, IBk } from './bitkeeper';
import { OutputChannelLogger } from './log';
import { Model } from './model';
import * as path from 'path';
import * as os from 'os';
import { eventToPromise, filterEvent, toDisposable } from './util';
import { BkFileSystemProvider } from './fileSystemProvider';
import { CommandCenter } from './commands';
import { BkDecorations } from './decorationProvider';
import { BkExtension } from './api/bk';
import { BkExtensionImpl } from './api/extension';
import { registerAPICommands } from './api/api1';




// function createResourceUri(relativePath: string): vscode.Uri {
// 	if ( vscode.workspace.workspaceFolders) {
// 		const absolutePath = path.join(vscode.workspace.workspaceFolders[0].uri.toString(), relativePath);
// 		return vscode.Uri.file(absolutePath);
// 	}
// 	return vscode.Uri.file(relativePath);
// }

async function checkBkVersion(info: IBk): Promise<void> {
	await checkBkv1(info);

	if (process.platform === 'win32') {
		await checkBkWindows(info);
	}
}

async function checkBkWindows(info: IBk): Promise<void> {
	if (!/^2\.(25|26)\./.test(info.version)) {
		return;
	}

	const config = workspace.getConfiguration('bk');
	const shouldIgnore = config.get<boolean>('ignoreWindowsBk27Warning') === true;

	if (shouldIgnore) {
		return;
	}

	const update = localize('updateBk', "Update Bk");
	const neverShowAgain = localize('neverShowAgain', "Don't Show Again");
	const choice = await window.showWarningMessage(
		localize('bk2526', "There are known issues with the installed Bk {0}. Please update to Bk >= 2.27 for the bk features to work correctly.", info.version),
		update,
		neverShowAgain
	);

	if (choice === update) {
		commands.executeCommand('vscode.open', Uri.parse('https://aka.ms/vscode-download-bk'));
	} else if (choice === neverShowAgain) {
		await config.update('ignoreWindowsBk27Warning', true, true);
	}
}

async function checkBkv1(info: IBk): Promise<void> {
	const config = workspace.getConfiguration('bk');
	const shouldIgnore = config.get<boolean>('ignoreLegacyWarning') === true;

	if (shouldIgnore) {
		return;
	}

	if (!/^[01]/.test(info.version)) {
		return;
	}

	const update = localize('updateBk', "Update Bk");
	const neverShowAgain = localize('neverShowAgain', "Don't Show Again");

	const choice = await window.showWarningMessage(
		localize('bk20', "You seem to have bk {0} installed. Code works best with bk >= 2", info.version),
		update,
		neverShowAgain
	);

	if (choice === update) {
		commands.executeCommand('vscode.open', Uri.parse('https://aka.ms/vscode-download-bk'));
	} else if (choice === neverShowAgain) {
		await config.update('ignoreLegacyWarning', true, true);
	}
}



async function createModel(context: ExtensionContext, outputChannelLogger: OutputChannelLogger, disposables: Disposable[]): Promise<Model> {
	const pathValue = workspace.getConfiguration('bk').get<string | string[]>('path');
	let pathHints = Array.isArray(pathValue) ? pathValue : pathValue ? [pathValue] : [];

	const { isTrusted, workspaceFolders = [] } = workspace;
	const excludes = isTrusted ? [] : workspaceFolders.map(f => path.normalize(f.uri.fsPath).replace(/[\r\n]+$/, ''));

	if (!isTrusted && pathHints.length !== 0) {
		// Filter out any non-absolute paths
		pathHints = pathHints.filter(p => path.isAbsolute(p));
	}

	const info = await findBk(pathHints, bkPath => {
		//outputChannelLogger.logInfo(localize('validating', "Validating found bk in: {0}", bkPath));
		//console.log(localize('validating', "Validating found bk in: {0}", bkPath));
		if (excludes.length === 0) {
			return true;
		}

		const normalized = path.normalize(bkPath).replace(/[\r\n]+$/, '');
		const skip = excludes.some(e => normalized.startsWith(e));
		console.log(normalized, skip);
		if (skip) {
			outputChannelLogger.logInfo(localize('skipped', "Skipped found bk in: {0}", bkPath));
			console.log(localize('skipped', "Skipped found bk in: {0}", bkPath));
		}
		return !skip;
	});

	// let ipcServer: IPCServer | undefined = undefined;

	// try {
	// 	ipcServer = await createIPCServer(context.storagePath);
	// } catch (err) {
	// 	outputChannelLogger.logError(`Failed to create bk IPC: ${err}`);
	// }

	// const askpass = new Askpass(ipcServer);
	// disposables.push(askpass);

	// const bkEditor = new BkEditor(ipcServer);
	// disposables.push(bkEditor);

	// const environment = { ...askpass.getEnv(), ...bkEditor.getEnv(), ...ipcServer?.getEnv() };
	// const terminalEnvironmentManager = new TerminalEnvironmentManager(context, [askpass, bkEditor, ipcServer]);
	// disposables.push(terminalEnvironmentManager);

	outputChannelLogger.logInfo(localize('using bk', "Using bk {0} from {1}", info.version, info.path));

	const bk = new Bk({
		bkPath: info.path,
		userAgent: `bk/${info.version} (${(os as any).version?.() ?? os.type()} ${os.release()}; ${os.platform()} ${os.arch()}) `, //vscode/${vscodeVersion} (${env.appName})
		version: info.version,
		env: env,//environment,
	});
	const model = new Model(bk, context.globalState, outputChannelLogger);
	disposables.push(model);

	const onRepository = () => commands.executeCommand('setContext', 'bkOpenRepositoryCount', `${model.repositories.length}`);
	model.onDidOpenRepository(onRepository, null, disposables);
	model.onDidCloseRepository(onRepository, null, disposables);
	onRepository();

	const onOutput = (str: string) => {
		const lines = str.split(/\r?\n/mg);

		while (/^\s*$/.test(lines[lines.length - 1])) {
			lines.pop();
		}

		outputChannelLogger.log(lines.join('\n'));
	};
	bk.onOutput.addListener('log', onOutput);
	disposables.push(toDisposable(() => bk.onOutput.removeListener('log', onOutput)));

	const cc = new CommandCenter(bk, model, outputChannelLogger);
	disposables.push(
		cc,
		new BkFileSystemProvider(model),
		new BkDecorations(model),
		//new BkTimelineProvider(model, cc),
		//new BkEditSessionIdentityProvider(model)
	);

	// const postCommitCommandsProvider = new BkPostCommitCommandsProvider();
	// model.registerPostCommitCommandsProvider(postCommitCommandsProvider);

	checkBkVersion(info);

	return model;
}







// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
// export function activate(context: vscode.ExtensionContext) {

// 	// Use the console to output diagnostic information (console.log) and errors (console.error)
// 	// This line of code will only be executed once when your extension is activated
// 	console.log('Congratulations, your extension "bkscm" is now active!');

// 	const bkSCM = vscode.scm.createSourceControl('bk', 'BitKeeper');
// 	const workingTree = bkSCM.createResourceGroup('workingTree', 'Changes');

// 	//need to initialize the current state of the repo.

// 	//const index = bkSCM.createResourceGroup('index', 'Index');
// 	// index.resourceStates = [
// 	//   { resourceUri: createResourceUri('README.md') },
// 	//   { resourceUri: createResourceUri('src/test/api.ts') }
// 	// ];

// 	// workingTree.resourceStates = [
// 	//   { resourceUri: createResourceUri('.travis.yml') },
// 	//   { resourceUri: createResourceUri('README.md') }
// 	// ];

// 	// The command has been defined in the package.json file
// 	// Now provide the implementation of the command with registerCommand
// 	// The commandId parameter must match the command field in package.json
// 	let disposable = commands.registerCommand('bkscm.initrepo', () => {
// 		// The code you place here will be executed every time your command is executed
// 		// Display a message box to the user
// 		vscode.window.showInformationMessage('Initialize Repository');
// 	});

// 	context.subscriptions.push(disposable);
// }

export async function _activate(context: ExtensionContext): Promise<BkExtensionImpl> {
	const disposables: Disposable[] = [];
	context.subscriptions.push(new Disposable(() => Disposable.from(...disposables).dispose()));

	const outputChannelLogger = new OutputChannelLogger();
	disposables.push(outputChannelLogger);

	//disposables.push(new BkProtocolHandler(outputChannelLogger));

	//const { name, version, aiKey } = require('../package.json') as { name: string; version: string; aiKey: string; };
	//const telemetryReporter = new TelemetryReporter(name, version, aiKey);
	//deactivateTasks.push(() => telemetryReporter.dispose());

	const config = workspace.getConfiguration('bk', null);
	const enabled = config.get<boolean>('enabled');

	if (!enabled) {
		const onConfigChange = filterEvent(workspace.onDidChangeConfiguration, e => e.affectsConfiguration('bk'));
		const onEnabled = filterEvent(onConfigChange, () => workspace.getConfiguration('bk', null).get<boolean>('enabled') === true);
		const result = new BkExtensionImpl();

		eventToPromise(onEnabled).then(async () => result.model = await createModel(context, outputChannelLogger, disposables));
		return result;
	}

	try {
		const model = await createModel(context, outputChannelLogger, disposables);
		return new BkExtensionImpl(model);
	} catch (err: any) {
		if (!/Bk installation not found/.test(err.message || '')) {
			throw err;
		}

		console.warn(err.message);
		outputChannelLogger.logWarning(err.message);

		/* __GDPR__
			"bk.missing" : {
				"owner": "lszomoru"
			}
		*/
		//telemetryReporter.sendTelemetryEvent('bk.missing');

		commands.executeCommand('setContext', 'bk.missing', true);
		//warnAboutMissingBk();

		return new BkExtensionImpl();
	}
}

let _context: ExtensionContext;
export function getExtensionContext(): ExtensionContext {
	return _context;
}

export async function activate(context: ExtensionContext): Promise<BkExtension> {
	_context = context;

	const result = await _activate(context);
	context.subscriptions.push(registerAPICommands(result));
	return result;
}

// this method is called when your extension is deactivated
export function deactivate() { }
