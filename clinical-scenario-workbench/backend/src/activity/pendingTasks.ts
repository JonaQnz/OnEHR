import crypto from 'node:crypto';
import { readJsonFile, writeJsonFile } from '../world/jsonStore';

/**
 * The missing order lifecycle (user's own ask, live-audited against the two
 * pregnancy cases: "Aufgaben des Arztes werden erst ausgeführt, wenn Pflege
 * zu der Person kommt"). Before this, `medication-order`/`order-basis`
 * wrote their order document and that was it - nothing tracked whether it
 * had actually been carried out. A PendingTask is the gap between "ordered"
 * and "done": filed the moment an order opts in (via `data.pendingResult` -
 * see scenario/engine.ts's medication-order/order-basis cases), consumed
 * the moment a `nursing-round` event actually executes it for real
 * (scenario/engine.ts's `executePendingTasks`), and read back by the NEXT
 * `doctor-round` so the doctor's own note reflects a real result instead of
 * a canned string.
 *
 * Per-run JSON store, same shape/style as critic/taskStore.ts.
 */
export type PendingTaskKind = 'medication-administration' | 'lab-value';

export interface PendingTask {
  id: string;
  kind: PendingTaskKind;
  description: string;
  orderedByRole: 'doctor' | 'nurse';
  orderEventId: string;
  patientScenarioKey: string;
  status: 'pending' | 'done';
  /** Exactly the `data` the eventual capability write (medication-
   * administration/lab-value) needs - captured at order time so execution
   * later doesn't have to re-derive it. */
  payload: Record<string, unknown>;
  createdAt: string;
  completedAt?: string;
  completedByEventId?: string;
  /** Set once a later doctor-round has reflected this result in its own
   * note - so the SAME completed task is never summarized twice. */
  reviewedByDoctor: boolean;
}

type StoreFile = Record<string, PendingTask>;

export class PendingTaskStore {
  private tasks: StoreFile;

  constructor(private readonly dataDir: string, private readonly scenarioRunId: string) {
    this.tasks = readJsonFile<StoreFile>(dataDir, scenarioRunId, 'pending-tasks', {});
  }

  fileFor(input: { kind: PendingTaskKind; description: string; orderedByRole: 'doctor' | 'nurse'; orderEventId: string; patientScenarioKey: string; payload: Record<string, unknown> }): PendingTask {
    const task: PendingTask = { ...input, id: crypto.randomUUID(), status: 'pending', createdAt: new Date().toISOString(), reviewedByDoctor: false };
    this.tasks[task.id] = task;
    writeJsonFile(this.dataDir, this.scenarioRunId, 'pending-tasks', this.tasks);
    return task;
  }

  listPending(patientScenarioKey: string): PendingTask[] {
    return Object.values(this.tasks).filter((task) => task.patientScenarioKey === patientScenarioKey && task.status === 'pending');
  }

  listUnreviewedDone(patientScenarioKey: string): PendingTask[] {
    return Object.values(this.tasks).filter((task) => task.patientScenarioKey === patientScenarioKey && task.status === 'done' && !task.reviewedByDoctor);
  }

  complete(id: string, completedByEventId: string): PendingTask {
    const task = this.tasks[id];
    if (!task) throw new Error(`No pending task "${id}" to complete.`);
    task.status = 'done';
    task.completedAt = new Date().toISOString();
    task.completedByEventId = completedByEventId;
    writeJsonFile(this.dataDir, this.scenarioRunId, 'pending-tasks', this.tasks);
    return task;
  }

  markReviewed(id: string): void {
    const task = this.tasks[id];
    if (!task) return;
    task.reviewedByDoctor = true;
    writeJsonFile(this.dataDir, this.scenarioRunId, 'pending-tasks', this.tasks);
  }

  list(): PendingTask[] {
    return Object.values(this.tasks);
  }
}
