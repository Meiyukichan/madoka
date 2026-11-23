// Stable import surface for the link table. Shapes and pure rules live in ../model.ts;
// the link layer imports them here so no module has to remember two sets of paths.

export type {
  CommentSide,
  IssueLink,
  IssueLinkPatch,
  LinkIndexFile,
} from '../model.ts'

export {
  COMMENT_SIDES,
  LINK_SCHEMA_VERSION,
  isEmptyLink,
  mergeLink,
  oppositeSide,
  pendingFieldOf,
  targetSessionId,
  targetsSide,
} from '../model.ts'
