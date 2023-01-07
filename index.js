/**
 * External dependencies
 */
const { getOctokit, context } = require( '@actions/github' );
const { setFailed, getInput } = require( '@actions/core' );
const sizeLimit = require( 'size-limit' );
const filePlugin = require( '@size-limit/file' );
const fs = require('fs/promises')
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
    return prettyBytes(newSize) +
        " - " + prettyBytes(oldSize) +
        " = " + prettyBytes(newSize - oldSize, {signed: true}) +
        " ( "+computePercentageDiff(oldSize, newSize) + " )";
}


async function fetchPreviousComment(
    octokit,
    repo,
    pr
) {
    const commentList = await octokit.paginate(
        "GET /repos/:owner/:repo/issues/:issue_number/comments",
        {
            ...repo,
            // eslint-disable-next-line camelcase
            issue_number: pr.number
        }
    );

    const sizeLimitComment = commentList.find(comment =>
        comment.body.startsWith(HEADING)
    );
    return !sizeLimitComment ? null : sizeLimitComment;
}

function emitErrorNoPermission(prefix) {
    console.log(prefix+" This can happen on PR's originating from a fork without write permissions.");
}

async function postOrEditComment(octokit, repo, pr, content) {
    const previousComment = await fetchPreviousComment(octokit, repo, pr);

    if (!previousComment) {
        try {
            await octokit.issues.createComment({
                ...repo,
                issue_number: pr.number,
                body: HEADING + content
            });
        } catch (error) {
            emitErrorNoPermission("Error creating comment.");
        }
    } else {
        try {
            await octokit.issues.updateComment({
                ...repo,
                comment_id: previousComment.id,
                body: HEADING + content
            });
        } catch (error) {
            emitErrorNoPermission("Error updating comment.");
        }
    }
}

async function readJSON(filePath, defaultValue) {
    try {
        const content = await fs.readFile(filePath, 'utf8')
        return JSON.parse(content);
    } catch(e) {
        return defaultValue;
    }
}

async function run() {
    const token = getInput( 'github-token', { required: true } );
    const octokit = getOctokit( token );
    const payload = context.payload;
    const oldAssetsFolder = getInput( 'old-assets-folder', {
        required: true,
    } );
    const oldAssetsBranch = getInput( 'old-assets-branch', {
        required: true,
    } );
    const newAssetsFolder = getInput( 'new-assets-folder', {
        required: true,
    } );

    const oldAssets = readJSON(oldAssetsFolder + '/assets.json', {});

    const files = await fs.readdir(newAssetsFolder);
    console.log(files);

    const newAssets = readJSON( newAssetsFolder + '/assets.json', false );

    if ( ! newAssets ) {
        return;
    }

    const changes = Object.fromEntries(
        Object.entries( newAssets )
            .filter( ( [ key, { version } ] ) => {
                return !oldAssets[key] || oldAssets[key].version !== version;
            })
    );

    if ( Object.keys( changes ).length === 0 ) {
        return;
    }

    let reportContent = '';

    for (const [ asset, { dependencies } ] of Object.entries(changes)) {
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
                    "files": [newAssetsFolder+"/"+asset]
                }]
            })
        ];
        if (oldDependencies[asset]) {
            sizesPromises.push(
                sizeLimit([ filePlugin ], {
                    "checks": [{
                        "files": [oldAssetsFolder+"/"+asset]
                    }]
                })
            )
        } else {
            sizesPromises.push(Promise.resolve(0));
        }

        const sizes = await Promise.all(sizesPromises);

        const sizeDiff = computeSizeDiff(sizes[1], sizes[0]);

        reportContent +=
            `| \`${asset}\` | ${addedDeps} | ${removedDeps} | ${sizeDiff} |` +
            '\n';
    }

    await postOrEditComment(octokit, payload.repository, payload.pull_request,
        'The `github-action-wordpress-dependencies-report` action has detected some script changes between this branch and ' + oldAssetsBranch +
        '. Please review and confirm the following are correct before merging.' +
        '\n\n' +
        '| Script Handle | Added Dependencies |  Removed Dependencies | Size Diff |' +
        '\n' +
        '| ------------- | ------- |  ------- | ------- | ' +
        '\n' +
        reportContent +
        '\n\n' +
        '__This comment was automatically generated by the `github-action-wordpress-dependencies-report` action.__',
    );
}

run().catch(error => setFailed(error.message));
