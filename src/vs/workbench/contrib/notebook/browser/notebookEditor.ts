/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from 'vs/base/browser/dom';
import { CancellationToken } from 'vs/base/common/cancellation';
import { Emitter, Event } from 'vs/base/common/event';
import { MutableDisposable, DisposableStore } from 'vs/base/common/lifecycle';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { BaseEditor } from 'vs/workbench/browser/parts/editor/baseEditor';
import { EditorOptions, IEditorMemento, IEditorInput } from 'vs/workbench/common/editor';
import { NotebookEditorInput } from 'vs/workbench/contrib/notebook/browser/notebookEditorInput';
import { INotebookEditorViewState, NotebookViewModel } from 'vs/workbench/contrib/notebook/browser/viewModel/notebookViewModel';
import { IEditorGroup, IEditorGroupsService } from 'vs/workbench/services/editor/common/editorGroupsService';
import { NotebookEditorWidget, NotebookEditorOptions } from 'vs/workbench/contrib/notebook/browser/notebookEditorWidget';
import { EditorPart } from 'vs/workbench/browser/parts/editor/editorPart';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IEditorOptions, ITextEditorOptions } from 'vs/platform/editor/common/editor';
import { INotebookEditorWidgetService, IBorrowValue } from 'vs/workbench/contrib/notebook/browser/notebookEditorWidgetService';
import { localize } from 'vs/nls';

const NOTEBOOK_EDITOR_VIEW_STATE_PREFERENCE_KEY = 'NotebookEditorViewState';

export class NotebookEditor extends BaseEditor {
	static readonly ID: string = 'workbench.editor.notebook';

	private readonly _editorMemento: IEditorMemento<INotebookEditorViewState>;
	private readonly _groupListener = this._register(new MutableDisposable());
	private readonly _widgetDisposableStore: DisposableStore = new DisposableStore();
	private _widget: IBorrowValue<NotebookEditorWidget> = { value: undefined };
	private _rootElement!: HTMLElement;
	private _dimension?: DOM.Dimension;

	// todo@rebornix is there a reason that `super.fireOnDidFocus` isn't used?
	private readonly _onDidFocusWidget = this._register(new Emitter<void>());
	get onDidFocus(): Event<any> { return this._onDidFocusWidget.event; }

	private readonly _onDidChangeModel = this._register(new Emitter<void>());
	readonly onDidChangeModel: Event<void> = this._onDidChangeModel.event;

	constructor(
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupService: IEditorGroupsService,
		@INotificationService private readonly _notificationService: INotificationService,
		@INotebookEditorWidgetService private readonly _notebookWidgetService: INotebookEditorWidgetService,
	) {
		super(NotebookEditor.ID, telemetryService, themeService, storageService);
		this._editorMemento = this.getEditorMemento<INotebookEditorViewState>(_editorGroupService, NOTEBOOK_EDITOR_VIEW_STATE_PREFERENCE_KEY);
	}

	set viewModel(newModel: NotebookViewModel | undefined) {
		if (this._widget.value) {
			this._widget.value.viewModel = newModel;
			this._onDidChangeModel.fire();
		}
	}

	get viewModel() {
		return this._widget.value?.viewModel;
	}

	get minimumWidth(): number { return 375; }
	get maximumWidth(): number { return Number.POSITIVE_INFINITY; }

	// these setters need to exist because this extends from BaseEditor
	set minimumWidth(value: number) { /*noop*/ }
	set maximumWidth(value: number) { /*noop*/ }

	//#region Editor Core

	get isNotebookEditor() {
		return true;
	}

	protected createEditor(parent: HTMLElement): void {
		this._rootElement = DOM.append(parent, DOM.$('.notebook-editor'));

		// this._widget.createEditor();
		this._register(this.onDidFocus(() => this._widget.value?.updateEditorFocus()));
		this._register(this.onDidBlur(() => this._widget.value?.updateEditorFocus()));
	}

	getDomNode() {
		return this._rootElement;
	}

	getControl(): NotebookEditorWidget | undefined {
		return this._widget.value;
	}

	setEditorVisible(visible: boolean, group: IEditorGroup | undefined): void {
		super.setEditorVisible(visible, group);
		this._groupListener.value = group?.onWillCloseEditor(e => this._saveEditorViewState(e.editor));

		if (!visible) {
			this._saveEditorViewState(this.input);
			if (this.input && this._widget.value) {
				// the widget is not transfered to other editor inputs
				this._widget.value.onWillHide();
			}
		}
	}

	focus() {
		super.focus();
		this._widget.value?.focus();
	}

	async setInput(input: NotebookEditorInput, options: EditorOptions | undefined, token: CancellationToken): Promise<void> {

		const group = this.group!;

		this._saveEditorViewState(this.input);
		await super.setInput(input, options, token);

		this._widgetDisposableStore.clear();

		// there currently is a widget which we still own so
		// we need to hide it before getting a new widget
		if (this._widget.value) {
			this._widget.value.onWillHide();
		}

		this._widget = this.instantiationService.invokeFunction(this._notebookWidgetService.retrieveWidget, group, input);

		if (this._dimension) {
			this._widget.value!.layout(this._dimension, this._rootElement);
		}

		const model = await input.resolve(this._widget.value!.getId());

		if (model === null) {
			this._notificationService.prompt(
				Severity.Error,
				localize('fail.noEditor', "Cannot open resource with notebook editor type '${input.viewType}', please check if you have the right extension installed or enabled."),
				[{
					label: localize('fail.reOpen', "Reopen file with VS Code standard text editor"),
					run: async () => {
						const fileEditorInput = this._editorService.createEditorInput({ resource: input.resource, forceFile: true });
						const textOptions: IEditorOptions | ITextEditorOptions = options ? { ...options, override: false } : { override: false };
						await this._editorService.openEditor(fileEditorInput, textOptions);
					}
				}]
			);
			return;
		}

		const viewState = this._loadTextEditorViewState(input);

		await this._widget.value!.setModel(model.notebook, viewState);
		await this._widget.value!.setOptions(options instanceof NotebookEditorOptions ? options : undefined);
		this._widgetDisposableStore.add(this._widget.value!.onDidFocus(() => this._onDidFocusWidget.fire()));

		if (this._editorGroupService instanceof EditorPart) {
			this._widgetDisposableStore.add(this._editorGroupService.createEditorDropTarget(this._widget.value!.getDomNode(), {
				groupContainsPredicate: (group) => this.group?.id === group.group.id
			}));
		}
	}

	clearInput(): void {
		if (this._widget.value) {
			this._widget.value.onWillHide();
		}
		super.clearInput();
	}

	setOptions(options: EditorOptions | undefined): void {
		if (options instanceof NotebookEditorOptions) {
			this._widget.value?.setOptions(options);
		}
		super.setOptions(options);
	}

	protected saveState(): void {
		this._saveEditorViewState(this.input);
		super.saveState();
	}

	private _saveEditorViewState(input: IEditorInput | undefined): void {
		if (this.group && this._widget.value && input instanceof NotebookEditorInput) {
			const state = this._widget.value.getEditorViewState();
			this._editorMemento.saveEditorState(this.group, input.resource, state);
		}
	}

	private _loadTextEditorViewState(input: NotebookEditorInput): INotebookEditorViewState | undefined {
		if (this.group) {
			return this._editorMemento.loadEditorState(this.group, input.resource);
		}

		return;
	}

	layout(dimension: DOM.Dimension): void {
		this._rootElement.classList.toggle('mid-width', dimension.width < 1000 && dimension.width >= 600);
		this._rootElement.classList.toggle('narrow-width', dimension.width < 600);
		this._dimension = dimension;

		if (!this._widget.value || !(this._input instanceof NotebookEditorInput)) {
			return;
		}

		if (this._input.resource.toString() !== this._widget.value.viewModel?.uri.toString() && this._widget.value?.viewModel) {
			// input and widget mismatch
			// this happens when
			// 1. open document A, pin the document
			// 2. open document B
			// 3. close document B
			// 4. a layout is triggered
			return;
		}

		this._widget.value.layout(this._dimension, this._rootElement);
	}

	//#endregion

	//#region Editor Features

	//#endregion

	dispose() {
		super.dispose();
	}

	toJSON(): any {
		return {
			notebookHandle: this.viewModel?.handle
		};
	}
}
