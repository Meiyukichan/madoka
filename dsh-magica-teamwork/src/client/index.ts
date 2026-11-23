/**
 * teamwork 组件库出口：model（纯 TS）+ components / pages / detail（React）。
 *
 * 宿主（castboard 面板）从这里拿组件与 `UI_CSS`，自己负责注入样式与卸载回收。
 *
 * @module dsh-magica-teamwork/client
 */
export * from './model/view.js'
export * from './model/permissions.js'
export * from './model/load.js'
export * from './model/labels.js'
export * from './model/toast.js'
export * from './model/columns.js'
export * from './styles/ui-css.js'
export {
  Avatar,
  Badge,
  Button,
  Card,
  Column as ColumnView,
  Empty,
  Input,
  ListGate,
  Modal,
  PersonPicker,
  ProjectsCards,
  Spinner,
  Tabs,
  Toasts,
} from './components/index.js'
export * from './pages/board.js'
export * from './pages/teamwork.js'
export * from './detail/task-detail.js'
export * from './auth/login-modal.js'

/** 组件库对外承诺的版本（与 package 版本解耦，界面侧只做能力探测）。 */
export const TEAMWORK_UI_VERSION = '0.2.0-alpha.1'
