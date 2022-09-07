// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import path = require('path');
import * as vscode from 'vscode';




function createResourceUri(relativePath: string): vscode.Uri {
	if ( vscode.workspace.workspaceFolders) {
		const absolutePath = path.join(vscode.workspace.workspaceFolders[0].uri.toString(), relativePath);
		return vscode.Uri.file(absolutePath);
	}
	return vscode.Uri.file(relativePath);
}
  

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	
	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "bkscm" is now active!');

	const bkSCM = vscode.scm.createSourceControl('bk', 'BitKeeper');
	const workingTree = bkSCM.createResourceGroup('workingTree', 'Changes');

	//need to initialize the current state of the repo. 

	//const index = gitSCM.createResourceGroup('index', 'Index');
	// index.resourceStates = [
	//   { resourceUri: createResourceUri('README.md') },
	//   { resourceUri: createResourceUri('src/test/api.ts') }
	// ];

	// workingTree.resourceStates = [
	//   { resourceUri: createResourceUri('.travis.yml') },
	//   { resourceUri: createResourceUri('README.md') }
	// ];
  
	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	let disposable = vscode.commands.registerCommand('bkscm.initrepo', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Initialize Repository');
	});

	context.subscriptions.push(disposable);
}

// this method is called when your extension is deactivated
export function deactivate() {}
