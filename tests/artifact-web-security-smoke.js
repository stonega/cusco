import {
    artifactContentSecurityPolicy,
    artifactWebUri,
    isArtifactWebUriAllowed,
    parseArtifactWebUri,
} from '../src/artifacts/web/runtime.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const binding = {
    artifactId: 'artifact-1',
    revisionId: 'revision-1',
};
const uri = artifactWebUri(binding.artifactId, binding.revisionId, 'assets/app.js');
const parsed = parseArtifactWebUri(uri);

assert(parsed?.artifactId === binding.artifactId, 'Artifact URI lost its artifact ID');
assert(parsed?.revisionId === binding.revisionId, 'Artifact URI lost its revision ID');
assert(parsed?.relativePath === 'assets/app.js', 'Artifact URI lost its relative path');
assert(isArtifactWebUriAllowed(uri, binding), 'Bound artifact URI was rejected');
assert(!isArtifactWebUriAllowed(
    artifactWebUri('artifact-2', binding.revisionId, 'assets/app.js'),
    binding,
), 'Cross-artifact URI was allowed');
assert(!isArtifactWebUriAllowed(
    artifactWebUri(binding.artifactId, 'revision-2', 'assets/app.js'),
    binding,
), 'Cross-revision URI was allowed');
assert(!isArtifactWebUriAllowed('https://example.com/', binding), 'Network URI was allowed');
assert(parseArtifactWebUri('cusco-artifact://artifact-1/revision-1/../secret') === null,
    'Artifact traversal URI was accepted');

const offlinePolicy = artifactContentSecurityPolicy(['scripts']);
assert(offlinePolicy.includes("connect-src 'self'"), 'Offline policy lost same-artifact resources');
assert(!offlinePolicy.includes('connect-src \'self\' https:'), 'Offline policy allowed HTTPS connections');
assert(offlinePolicy.includes("object-src 'none'"), 'Offline policy did not block objects');
assert(offlinePolicy.includes("form-action 'none'"), 'Offline policy did not block forms');

const onlinePolicy = artifactContentSecurityPolicy(['scripts', 'network']);
assert(onlinePolicy.includes("connect-src 'self' https: http:"), 'Network capability was not reflected in CSP');

print('Cusco artifact web security smoke passed');
