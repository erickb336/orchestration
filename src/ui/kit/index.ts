// The component kit. Screens use these for every role they cover, so the UI stays consistent;
// the gallery at #/kit (Gallery.tsx) shows each one in every state.
//
// Load order: kit.css builds on the tokens in styles.css and overrides some of its element rules, so styles.css
// is imported here first. Modules evaluate once, so the later import in main.tsx changes nothing.
import "../styles.css";
import "./kit.css";

export { Actions, Button, ButtonLink, type ButtonLinkProps, type ButtonProps, type ButtonSize, type ButtonVariant } from "./Button";
export { Chip, SIMULATED_TITLE, SimulatedChip, type Tone } from "./Chip";
export { StatePill } from "./StatePill";
export { Card, type CardProps } from "./Card";
export { Banner, type BannerTone } from "./Banner";
export { NeedsYouItem, Row, Rows, type NeedsYouItemProps, type RowProps } from "./Row";
export { Checkbox, Field, Input, Select, Textarea, useFieldControl, type FieldProps, type SelectOption } from "./Field";
export { Disclosure, type DisclosureProps } from "./Disclosure";
export { ConfirmDialog, ConfirmPanel, ConfirmProvider, InlineConfirm, useConfirm, type ConfirmDialogProps, type ConfirmOptions } from "./Confirm";
export { SegmentedControl, Tabs, type SegmentOption, type SegmentedControlProps, type TabItem, type TabsProps } from "./Tabs";
export { SideNav, SideNavLayout, type SideNavItem, type SideNavProps } from "./SideNav";
export { STEP_MARK, STEP_WORD, StepList, type StepItem, type StepMark } from "./StepList";
export { EmptyState } from "./EmptyState";
export { Toast, ToastRegion, type ToastProps, type ToastTone } from "./Toast";
export { placeInWindow, useInWindow } from "./inWindow";
