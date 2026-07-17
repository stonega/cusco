import GLib from 'gi://GLib?version=2.0';

import {
    filterComposerSuggestions,
    findComposerTrigger,
    HomeFileIndex,
    listPathExecutables,
} from '../src/composer/references.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const skillTrigger = findComposerTrigger('Use $rev', 8);
assert(
    skillTrigger?.trigger === '$'
        && skillTrigger.query === 'rev'
        && skillTrigger.startOffset === 4
        && skillTrigger.endOffset === 8,
    'Skill trigger was not detected at the cursor',
);

const fileTrigger = findComposerTrigger('🙂 @Doczzz later', 6);
assert(
    fileTrigger?.trigger === '@'
        && fileTrigger.query === 'Doc'
        && fileTrigger.startOffset === 2
        && fileTrigger.endOffset === 9,
    'File trigger did not use GTK-compatible character offsets',
);

assert(findComposerTrigger('mail@example.com') === null, 'Email addresses must not open file search');
assert(findComposerTrigger('word#git') === null, 'Triggers must begin a new token');

const filtered = filterComposerSuggestions([
    { title: 'deploy', subtitle: 'Deploy the app' },
    { title: 'deep-review', subtitle: 'Review everything' },
    { title: 'docs', subtitle: 'Write docs' },
], 'dep', 2);
assert(
    filtered.length === 2 && filtered[0].title === 'deploy' && filtered[1].title === 'deep-review',
    'Suggestion filtering did not rank prefix and fuzzy matches',
);

const tempRoot = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-composer-references-${GLib.uuid_string_random()}`,
]);
const binDirectory = GLib.build_filenamev([tempRoot, 'bin']);
const nestedDirectory = GLib.build_filenamev([tempRoot, 'Documents', 'notes']);
const skippedDirectory = GLib.build_filenamev([tempRoot, 'node_modules']);
GLib.mkdir_with_parents(binDirectory, 0o700);
GLib.mkdir_with_parents(nestedDirectory, 0o700);
GLib.mkdir_with_parents(skippedDirectory, 0o700);

const commandPath = GLib.build_filenamev([binDirectory, 'cusco-test-command']);
const regularPath = GLib.build_filenamev([binDirectory, 'not-executable']);
GLib.file_set_contents(commandPath, '#!/bin/sh\n');
GLib.file_set_contents(regularPath, 'plain file\n');
GLib.chmod(commandPath, 0o700);
GLib.chmod(regularPath, 0o600);

const commands = listPathExecutables(binDirectory);
assert(commands.some((command) => command.title === 'cusco-test-command'), 'PATH command was not found');
assert(!commands.some((command) => command.title === 'not-executable'), 'Non-executable file was listed as a command');

const indexedPath = GLib.build_filenamev([nestedDirectory, 'ideas.md']);
const skippedPath = GLib.build_filenamev([skippedDirectory, 'package.js']);
GLib.file_set_contents(indexedPath, '# Ideas\n');
GLib.file_set_contents(skippedPath, 'ignored\n');

const loop = new GLib.MainLoop(null, false);
let timedOut = false;
const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
    timedOut = true;
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
const index = new HomeFileIndex({
    homePath: tempRoot,
    onChanged: (currentIndex) => {
        if (currentIndex.complete)
            loop.quit();
    },
});
index.start();
loop.run();
GLib.Source.remove(timeoutId);
index.stop();

assert(!timedOut, 'Home file indexing timed out');
assert(index.items.some((item) => item.value === indexedPath), 'Nested home file was not indexed');
assert(!index.items.some((item) => item.value === skippedPath), 'Noisy dependency directory was indexed');
assert(
    index.search('idea', 8).some((item) => item.value === indexedPath),
    'Home file search did not return a matching indexed file',
);
assert(
    index.search('ideas.md', 8).some((item) => item.value === indexedPath),
    'Narrowing a cached Home file search lost a matching file',
);
assert(
    index.search('id', 8).some((item) => item.value === indexedPath),
    'Broadening a cached Home file search did not rescan the index',
);

print('Cusco composer references smoke passed');
