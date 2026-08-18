import { z } from 'zod';

export const SubmitOptionsSchema = z.object({
  templateName: z.string().min(1),
  documentId: z.string().min(1),
  documentType: z.string().min(1),
  submittedBy: z.string().min(1),
  data: z.record(z.string(), z.unknown()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
  expiresAt: z.coerce.date().optional(),
  deadlineAction: z.enum(['cancel', 'reject']).optional(),
});

export const ApproveOptionsSchema = z.object({
  approverId: z.string().min(1),
  comment: z.string().optional(),
});

export const RejectOptionsSchema = z.object({
  approverId: z.string().min(1),
  reason: z.string().min(1),
  returnTo: z.enum(['originator', 'previous']).optional(),
});

export const DelegateOptionsSchema = z.object({
  fromApprover: z.string().min(1),
  toApprover: z.string().min(1),
  reason: z.string().min(1),
  until: z.coerce.date().optional(),
});

export const ReassignOptionsSchema = z.object({
  reassignedBy: z.string().min(1),
  fromApprover: z.string().min(1),
  toApprover: z.string().min(1),
  reason: z.string().min(1),
});

export const CancelOptionsSchema = z.object({
  cancelledBy: z.string().min(1),
  reason: z.string().min(1),
});

export const EscalateOptionsSchema = z.object({
  escalatedBy: z.string().min(1),
});

export const ResubmitOptionsSchema = z.object({
  resubmittedBy: z.string().min(1),
  reason: z.string().optional(),
  updatedData: z.record(z.string(), z.unknown()).optional(),
});

export const AddCommentOptionsSchema = z.object({
  actorId: z.string().min(1),
  comment: z.string().min(1),
});

export const OverrideOptionsSchema = z.object({
  overriddenBy: z.string().min(1),
  justification: z.string().min(1),
});

export type SubmitOptions = z.infer<typeof SubmitOptionsSchema>;
export type ApproveOptions = z.infer<typeof ApproveOptionsSchema>;
export type RejectOptions = z.infer<typeof RejectOptionsSchema>;
export type DelegateOptions = z.infer<typeof DelegateOptionsSchema>;
export type ReassignOptions = z.infer<typeof ReassignOptionsSchema>;
export type CancelOptions = z.infer<typeof CancelOptionsSchema>;
export type EscalateOptions = z.infer<typeof EscalateOptionsSchema>;
export type ResubmitOptions = z.infer<typeof ResubmitOptionsSchema>;
export type AddCommentOptions = z.infer<typeof AddCommentOptionsSchema>;
export type OverrideOptions = z.infer<typeof OverrideOptionsSchema>;
