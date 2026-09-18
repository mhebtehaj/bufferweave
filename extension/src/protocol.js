'use strict';

const PROTOCOL_VERSION = '3.0';

const METHODS = Object.freeze([
  'listWorkspaces',
  'listOpenDocuments',
  'readDocument',
  'previewEdits',
  'applyEdits',
  'saveDocument',
  'getDocumentChanges',
]);

module.exports = { METHODS, PROTOCOL_VERSION };
