import {
	ActiveExecutions,
	IProcessMessageDataHook,
	ITransferNodeTypes,
	IWorkflowExecutionDataProcess,
	IWorkflowExecutionDataProcessWithExecution,
	NodeTypes,
	Push,
	WorkflowExecuteAdditionalData,
	WorkflowHelpers,
} from './';

import {
	IProcessMessage,
	WorkflowExecute,
} from 'n8n-core';

import {
	IExecutionError,
	IRun,
	Workflow,
	WorkflowHooks,
	WorkflowExecuteMode,
} from 'n8n-workflow';

import * as config from '../config';
import * as PCancelable from 'p-cancelable';
import { join as pathJoin } from 'path';
import { fork } from 'child_process';


export class WorkflowRunner {
	activeExecutions: ActiveExecutions.ActiveExecutions;
	push: Push.Push;


	constructor() {
		this.push = Push.getInstance();
		this.activeExecutions = ActiveExecutions.getInstance();
	}


	/**
	 * The process did send a hook message so execute the appropiate hook
	 *
	 * @param {WorkflowHooks} workflowHooks
	 * @param {IProcessMessageDataHook} hookData
	 * @memberof WorkflowRunner
	 */
	processHookMessage(workflowHooks: WorkflowHooks, hookData: IProcessMessageDataHook) {
		workflowHooks.executeHookFunctions(hookData.hook, hookData.parameters);
	}


	/**
	 * The process did error
	 *
	 * @param {IExecutionError} error
	 * @param {Date} startedAt
	 * @param {WorkflowExecuteMode} executionMode
	 * @param {string} executionId
	 * @memberof WorkflowRunner
	 */
	processError(error: IExecutionError, startedAt: Date, executionMode: WorkflowExecuteMode, executionId: string) {
		const fullRunData: IRun = {
			data: {
				resultData: {
					error,
					runData: {},
				},
			},
			finished: false,
			mode: executionMode,
			startedAt,
			stoppedAt: new Date(),
		};

		// Remove from active execution with empty data. That will
		// set the execution to failed.
		this.activeExecutions.remove(executionId, fullRunData);

		// Also send to Editor UI
		WorkflowExecuteAdditionalData.pushExecutionFinished(executionMode, fullRunData, executionId);
	}


	/**
	 * Run the workflow
	 *
	 * @param {IWorkflowExecutionDataProcess} data
	 * @param {boolean} [loadStaticData] If set will the static data be loaded from
	 *                                   the workflow and added to input data
	 * @returns {Promise<string>}
	 * @memberof WorkflowRunner
	 */
	async run(data: IWorkflowExecutionDataProcess, loadStaticData?: boolean): Promise<string> {
		const executionsProcess = config.get('executions.process') as string;
		if (executionsProcess === 'main') {
			return this.runMainProcess(data, loadStaticData);
		}

		return this.runSubprocess(data, loadStaticData);
	}


	/**
	 * Run the workflow in current process
	 *
	 * @param {IWorkflowExecutionDataProcess} data
	 * @param {boolean} [loadStaticData] If set will the static data be loaded from
	 *                                   the workflow and added to input data
	 * @returns {Promise<string>}
	 * @memberof WorkflowRunner
	 */
	async runMainProcess(data: IWorkflowExecutionDataProcess, loadStaticData?: boolean): Promise<string> {
		if (loadStaticData === true && data.workflowData.id) {
			data.workflowData.staticData = await WorkflowHelpers.getStaticDataById(data.workflowData.id as string);
		}

		const nodeTypes = NodeTypes();

		const workflow = new Workflow(data.workflowData.id as string | undefined, data.workflowData!.nodes, data.workflowData!.connections, data.workflowData!.active, nodeTypes, data.workflowData!.staticData);
		const additionalData = await WorkflowExecuteAdditionalData.getBase(data.credentials);

		// Register the active execution
		const executionId = this.activeExecutions.add(data, undefined);

		additionalData.hooks = WorkflowExecuteAdditionalData.getWorkflowHooksMain(data, executionId);

		let workflowExecution: PCancelable<IRun>;
		if (data.executionData !== undefined) {
			const workflowExecute = new WorkflowExecute(additionalData, data.executionMode, data.executionData);
			workflowExecution = workflowExecute.processRunExecutionData(workflow);
		} else if (data.runData === undefined || data.startNodes === undefined || data.startNodes.length === 0 || data.destinationNode === undefined) {
			// Execute all nodes

			// Can execute without webhook so go on
			const workflowExecute = new WorkflowExecute(additionalData, data.executionMode);
			workflowExecution = workflowExecute.run(workflow, undefined, data.destinationNode);
		} else {
			// Execute only the nodes between start and destination nodes
			const workflowExecute = new WorkflowExecute(additionalData, data.executionMode);
			workflowExecution = workflowExecute.runPartialWorkflow(workflow, data.runData, data.startNodes, data.destinationNode);
		}

		this.activeExecutions.attachWorkflowExecution(executionId, workflowExecution);

		return executionId;
	}

	/**
	 * Run the workflow
	 *
	 * @param {IWorkflowExecutionDataProcess} data
	 * @param {boolean} [loadStaticData] If set will the static data be loaded from
	 *                                   the workflow and added to input data
	 * @returns {Promise<string>}
	 * @memberof WorkflowRunner
	 */
	async runSubprocess(data: IWorkflowExecutionDataProcess, loadStaticData?: boolean): Promise<string> {
		const startedAt = new Date();
		const subprocess = fork(pathJoin(__dirname, 'WorkflowRunnerProcess.js'));

		if (loadStaticData === true && data.workflowData.id) {
			data.workflowData.staticData = await WorkflowHelpers.getStaticDataById(data.workflowData.id as string);
		}

		// Register the active execution
		const executionId = this.activeExecutions.add(data, subprocess);

		// Check if workflow contains a "executeWorkflow" Node as in this
		// case we can not know which nodeTypes will be needed and so have
		// to load all of them in the workflowRunnerProcess
		let loadAllNodeTypes = false;
		for (const node of data.workflowData.nodes) {
			if (node.type === 'n8n-nodes-base.executeWorkflow') {
				loadAllNodeTypes = true;
				break;
			}
		}

		let nodeTypeData: ITransferNodeTypes;
		if (loadAllNodeTypes === true) {
			// Supply all nodeTypes
			nodeTypeData = WorkflowHelpers.getAllNodeTypeData();
		} else {
			// Supply only nodeTypes which the workflow needs
			nodeTypeData = WorkflowHelpers.getNodeTypeData(data.workflowData.nodes);
		}

		(data as unknown as IWorkflowExecutionDataProcessWithExecution).executionId = executionId;
		(data as unknown as IWorkflowExecutionDataProcessWithExecution).nodeTypeData = nodeTypeData;

		const workflowHooks = WorkflowExecuteAdditionalData.getWorkflowHooksMain(data, executionId);

		// Send all data to subprocess it needs to run the workflow
		subprocess.send({ type: 'startWorkflow', data } as IProcessMessage);

		// Listen to data from the subprocess
		subprocess.on('message', (message: IProcessMessage) => {
			if (message.type === 'end') {
				this.activeExecutions.remove(executionId!, message.data.runData);
			} else if (message.type === 'processError') {

				const executionError = message.data.executionError as IExecutionError;

				this.processError(executionError, startedAt, data.executionMode, executionId);

			} else if (message.type === 'processHook') {
				this.processHookMessage(workflowHooks, message.data as IProcessMessageDataHook);
			}
		});

		// Also get informed when the processes does exit especially when it did crash
		subprocess.on('exit', (code, signal) => {
			if (code !== 0) {
				// Process did exit with error code, so something went wrong.
				const executionError = {
					message: 'Workflow execution process did crash for an unknown reason!',
				} as IExecutionError;

				this.processError(executionError, startedAt, data.executionMode, executionId);
			}
		});

		return executionId;
	}
}
