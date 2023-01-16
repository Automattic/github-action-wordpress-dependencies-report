/**
 * External dependencies
 */
const { getOctokit, context } = require( '@actions/github' );
const { setFailed, getInput } = require( '@actions/core' );
const sizeLimit = require( 'size-limit' );
const filePlugin = require( '@size-limit/file' );
const fs = require('fs/promises')
const path = require('path');
import prettyBytes from 'pretty-bytes';

const HEADING = '# WordPress Dependencies Report\n\n';

function computePercentageDiff(oldSize, newSize) {
    if (oldSize === 0) {
        return "+100% 🔼";
    }

    const value = ((newSize - oldSize) / oldSize) * 100;
    const formatted =
        (Math.sign(value) * Math.ceil(Math.abs(value) * 100)) / 100;

    if (value > 0) {
        return `+${formatted}% 🔼`;
    }

    if (value === 0) {
        return `${formatted}%`;
    }

    return `${formatted}% ⬇️`;
}

function computeSizeDiff(oldSize, newSize) {
    return prettyBytes(newSize - oldSize, {signed: true}) +
        " ( "+computePercentageDiff(oldSize, newSize) + " )";
}


async function fetchPreviousComment(
    octokit,
    repo,
    pr
) {
    const commentList = await octokit.paginate(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
            owner: repo.owner.login,
            repo: repo.name,
            // eslint-disable-next-line camelcase
            issue_number: pr.number
        }
    );

    const sizeLimitComment = commentList.find(comment =>
        comment.body.startsWith(HEADING)
    );
    return !sizeLimitComment ? null : sizeLimitComment;
}

function emitErrorNoPermission(prefix, error) {
    console.log(prefix+" This can happen on PR's originating from a fork without write permissions.");
    console.log(error.message);
    console.log(error.stack);
}

async function postOrEditComment(octokit, repo, pr, content, onlyUpdate = false) {
    const previousComment = await fetchPreviousComment(octokit, repo, pr);

    if (!previousComment) {
        if ( onlyUpdate ) {
            return;
        }
        try {
            await octokit.rest.issues.createComment({
                owner: repo.owner.login,
                repo: repo.name,
                issue_number: pr.number,
                body: HEADING + content
            });
        } catch (error) {
            emitErrorNoPermission("Error creating comment.", error);
        }
    } else {
        try {
            await octokit.rest.issues.updateComment({
                owner: repo.owner.login,
                repo: repo.name,
                comment_id: previousComment.id,
                body: HEADING + content
            });
        } catch (error) {
            emitErrorNoPermission("Error updating comment.", error);
        }
    }
}

async function readFile(filePath, defaultContent) {
    try {
        return await fs.readFile(filePath, 'utf8')
    } catch(e) {
        return defaultContent;
    }
}

async function readJSON(filePath, defaultValue) {
    try {
        const content = await readFile(filePath, '');
        return JSON.parse(content);
    } catch(e) {
        return defaultValue;
    }
}

async function determineAssetPath(assetsFolder, jsAsset) {
    const jsPath = path.join(assetsFolder, jsAsset);
    if (jsAsset.endsWith("-style.js")) {
        const jsFile = await readFile(jsPath, '');
        if (jsFile.length === 0) {
            const cssPath = jsPath.replace(/-style.js$/, "-style.css");
            const cssFile = await readFile(cssPath, '');
            if (cssFile.length > 0) {
                return cssPath;
            }
        }
    }
    return jsPath;
}

async function run() {
    const token = getInput( 'github-token', { required: true } );
    const octokit = getOctokit( token );
    const payload = context.payload;
    const commit = payload.pull_request.head.sha;
    const oldAssetsFolder = getInput( 'old-assets-folder', {
        required: true,
    } );
    const oldAssetsBranch = getInput( 'old-assets-branch', {
        required: true,
    } );
    const newAssetsFolder = getInput( 'new-assets-folder', {
        required: true,
    } );

    const oldAssets = await readJSON(oldAssetsFolder + '/assets.json', {});
    const newAssets = await readJSON( newAssetsFolder + '/assets.json', false );

    if ( ! newAssets ) {
        return;
    }

    let reportContent = '';

    for (const [ asset, { dependencies } ] of Object.entries(newAssets)) {
        const newAssetPath = await determineAssetPath(newAssetsFolder, asset);
        const oldAssetPath = await determineAssetPath(oldAssetsFolder, asset);
        const oldDependencies = oldAssets[asset] ? oldAssets[ asset ].dependencies : [];
        const added = dependencies.filter(
            ( dependency ) =>
                ! oldDependencies.includes( dependency )
        );
        const removed = oldDependencies.filter(
            ( dependency ) => ! dependencies.includes( dependency )
        );

        const addedDeps = added.length
            ? '`' + added.join('`, `') + '`'
            : '';
        const removedDeps = removed.length
            ? '`' + removed.join('`, `') + '`'
            : '';

        const sizesPromises = [
            sizeLimit([ filePlugin ], {
                "checks": [{
                    "files": [newAssetPath]
                }]
            })
        ];
        if (oldAssets[asset]) {
            sizesPromises.push(
                sizeLimit([ filePlugin ], {
                    "checks": [{
                        "files": [oldAssetPath]
                    }]
                })
            )
        } else {
            sizesPromises.push(Promise.resolve( [ {size: 0} ] ));
        }

        const sizes = await Promise.all(sizesPromises);

        const sizeDiff = computeSizeDiff( sizes[1][0].size, sizes[0][0].size );

        const totalSize = prettyBytes(sizes[0][0].size);

        if (sizes[0][0].size === sizes[1][0].size && 0 === addedDeps.length && 0 === removedDeps.length ) {
            // If there are no changes, don't document the line.
            continue;
        }

        reportContent +=
            `| \`${asset}\` | ${addedDeps} | ${removedDeps} | ${totalSize} | ${sizeDiff} |` +
            '\n';
    }

    let onlyUpdate = false;

    let reportTable = '| Script Handle | Added Dependencies |  Removed Dependencies | Total Size | Size Diff |' +
        '\n' +
        '| ------------- | ------- |  ------- | ------- | ------- | ' +
        '\n' +
        reportContent;

    if (reportContent.length === 0) {
        // If there were changes before (aka a comment was posted before), we update it to reflect that there
        // were no changes detected anymore, so the edit history isn't lost.
        reportTable = 'No changes detected in the current commit. But the comment was left so it is possible to check for the edit history.';
        // We only publish this comment IF there is an update. We never create a comment with this content.
        onlyUpdate = true;
    }

    await postOrEditComment(octokit, payload.repository, payload.pull_request,
        'The `github-action-wordpress-dependencies-report` action has detected some script changes between the commit ' + commit + ' and ' + oldAssetsBranch +
        '. Please review and confirm the following are correct before merging.' +
        '\n\n' +
        reportTable  +
        '\n\n' +
        '__This comment was automatically generated by the `github-action-wordpress-dependencies-report` action.__',
        onlyUpdate
    );
}

run().catch(function(error) {
    console.log(error.stack);
    setFailed(error.message);
});
