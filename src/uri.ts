/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Uri } from 'vscode';

export interface BkUriParams {
	path: string;
	ref: string;
	submoduleOf?: string;
}

export function isBkUri(uri: Uri): boolean {
	return /^bk$/.test(uri.scheme);
}

export function fromBkUri(uri: Uri): BkUriParams {
	return JSON.parse(uri.query);
}

export interface BkUriOptions {
	replaceFileExtension?: boolean;
	submoduleOf?: string;
}

// As a mitigation for extensions like ESLint showing warnings and errors
// for bk URIs, let's change the file extension of these uris to .bk,
// when `replaceFileExtension` is true.
export function toBkUri(uri: Uri, ref: string, options: BkUriOptions = {}): Uri {
	const params: BkUriParams = {
		path: uri.fsPath,
		ref
	};

	if (options.submoduleOf) {
		params.submoduleOf = options.submoduleOf;
	}

	let path = uri.path;

	if (options.replaceFileExtension) {
		path = `${path}.bk`;
	} else if (options.submoduleOf) {
		path = `${path}.diff`;
	}

	return uri.with({
		scheme: 'bk',
		path,
		query: JSON.stringify(params)
	});
}

/**
 * Assuming `uri` is being merged it creates uris for `base`, `ours`, and `theirs`
 */
export function toMergeUris(uri: Uri): { base: Uri; ours: Uri; theirs: Uri } {
	return {
		base: toBkUri(uri, ':1'),
		ours: toBkUri(uri, ':2'),
		theirs: toBkUri(uri, ':3'),
	};
}
