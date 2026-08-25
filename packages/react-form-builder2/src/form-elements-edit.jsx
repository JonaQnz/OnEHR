import React from 'react';
import TextAreaAutosize from 'react-textarea-autosize';
import {
  ContentState, EditorState, convertFromHTML, convertToRaw,
} from 'draft-js';
import draftToHtml from 'draftjs-to-html';
import { Editor } from 'react-draft-wysiwyg';

import DynamicOptionList from './dynamic-option-list';
import { get } from './stores/requests';
import ID from './UUID';
import IntlMessages from './language-provider/IntlMessages';

const toolbar = {
  options: ['inline', 'list', 'textAlign', 'fontSize', 'link', 'history'],
  inline: {
    inDropdown: false,
    className: undefined,
    options: ['bold', 'italic', 'underline', 'superscript', 'subscript'],
  },
};

export default class FormElementsEdit extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      element: this.props.element,
      data: this.props.data,
      dirty: false,
    };
  }

  toggleRequired() {
    // const this_element = this.state.element;
  }

  editElementProp(elemProperty, targProperty, e) {
    // elemProperty could be content or label
    // targProperty could be value or checked
    const this_element = this.state.element;
    this_element[elemProperty] = e.target[targProperty];

    this.setState({
      element: this_element,
      dirty: true,
    }, () => {
      if (targProperty === 'checked') { this.updateElement(); }
    });
  }

  onEditorStateChange(index, property, editorContent) {
    // const html = draftToHtml(convertToRaw(editorContent.getCurrentContent())).replace(/<p>/g, '<div>').replace(/<\/p>/g, '</div>');
    const html = draftToHtml(convertToRaw(editorContent.getCurrentContent())).replace(/<p>/g, '').replace(/<\/p>/g, '').replace(/&nbsp;/g, ' ')
      .replace(/(?:\r\n|\r|\n)/g, ' ');
    const this_element = this.state.element;
    this_element[property] = html;

    this.setState({
      element: this_element,
      dirty: true,
    });
  }

  updateElement() {
    const this_element = this.state.element;
    // to prevent ajax calls with no change
    if (this.state.dirty) {
      this.props.updateElement.call(this.props.preview, this_element);
      this.setState({ dirty: false });
    }
  }

  convertFromHTML(content) {
    const newContent = convertFromHTML(content);
    if (!newContent.contentBlocks || !newContent.contentBlocks.length) {
      // to prevent crash when no contents in editor
      return EditorState.createEmpty();
    }
    const contentState = ContentState.createFromBlockArray(newContent);
    return EditorState.createWithContent(contentState);
  }

  addOptions() {
    const optionsApiUrl = document.getElementById('optionsApiUrl').value;
    if (optionsApiUrl) {
      get(optionsApiUrl).then(data => {
        this.props.element.options = [];
        const { options } = this.props.element;
        data.forEach(x => {
          // eslint-disable-next-line no-param-reassign
          x.key = ID.uuid();
          options.push(x);
        });
        const this_element = this.state.element;
        this.setState({
          element: this_element,
          dirty: true,
        });
      });
    }
  }

  getUIOptions(rmType) {
    const rm = rmType || '';
    if (rm === 'DV_DATE_TIME' || rm === 'DV_DATE' || rm === 'DV_TIME') {
      return [
        { value: 'DatePicker', label: 'Date/Time Picker' }
      ];
    }
    if (rm === 'DV_BOOLEAN') {
      return [
        { value: 'Checkboxes', label: 'Checkbox' },
        { value: 'RadioButtons', label: 'Radio Buttons' },
        { value: 'Dropdown', label: 'Dropdown' }
      ];
    }
    if (rm === 'DV_QUANTITY' || rm === 'DV_PROPORTION' || rm === 'DV_COUNT' || rm.includes('INTEGER')) {
      return [
        { value: 'NumberInput', label: 'Number Input' },
        { value: 'Range', label: 'Slider / Range' },
        { value: 'Rating', label: 'Star Rating' },
        { value: 'Dropdown', label: 'Dropdown' }
      ];
    }
    if (rm === 'DV_ORDINAL' || rm === 'DV_SCALE') {
      return [
        { value: 'Dropdown', label: 'Dropdown' },
        { value: 'RadioButtons', label: 'Radio Buttons' },
        { value: 'Range', label: 'Slider / Range' },
        { value: 'Rating', label: 'Star Rating' }
      ];
    }
    if (rm === 'CODE_PHRASE') {
      return [
        { value: 'Dropdown', label: 'Dropdown' },
        { value: 'RadioButtons', label: 'Radio Buttons' },
        { value: 'Checkboxes', label: 'Checkboxes' },
        { value: 'Tags', label: 'Tags Input' }
      ];
    }
    return [
      { value: 'TextInput', label: 'Text Input' },
      { value: 'TextArea', label: 'Text Area' },
      { value: 'Dropdown', label: 'Dropdown' },
      { value: 'RadioButtons', label: 'Radio Buttons' },
      { value: 'Checkboxes', label: 'Checkboxes' },
      { value: 'Tags', label: 'Tags Input' }
    ];
  }

  render() {
    if (this.state.dirty) {
      this.props.element.dirty = true;
    }

    const this_checked = this.props.element.hasOwnProperty('required') ? this.props.element.required : false;
    const this_read_only = this.props.element.hasOwnProperty('readOnly') ? this.props.element.readOnly : false;
    const this_default_today = this.props.element.hasOwnProperty('defaultToday') ? this.props.element.defaultToday : false;
    const this_show_time_select = this.props.element.hasOwnProperty('showTimeSelect') ? this.props.element.showTimeSelect : false;
    const this_show_time_select_only = this.props.element.hasOwnProperty('showTimeSelectOnly') ? this.props.element.showTimeSelectOnly : false;
    const this_show_time_input = this.props.element.hasOwnProperty('showTimeInput') ? this.props.element.showTimeInput : false;
    const this_checked_inline = this.props.element.hasOwnProperty('inline') ? this.props.element.inline : false;
    const this_checked_bold = this.props.element.hasOwnProperty('bold') ? this.props.element.bold : false;
    const this_checked_italic = this.props.element.hasOwnProperty('italic') ? this.props.element.italic : false;
    const this_checked_center = this.props.element.hasOwnProperty('center') ? this.props.element.center : false;
    const this_checked_page_break = this.props.element.hasOwnProperty('pageBreakBefore') ? this.props.element.pageBreakBefore : false;
    const this_checked_alternate_form = this.props.element.hasOwnProperty('alternateForm') ? this.props.element.alternateForm : false;

    const {
      canHavePageBreakBefore, canHaveAlternateForm, canHaveDisplayHorizontal, canHaveOptionCorrect, canHaveOptionValue,
    } = this.props.element;
    const canHaveImageSize = (this.state.element.element === 'Image' || this.state.element.element === 'Camera');

    const this_files = (this.props.files && this.props.files.length) ? this.props.files : [];
    if (this_files.length < 1 || (this_files.length > 0 && this_files[0].id !== '')) {
      this_files.unshift({ id: '', file_name: '' });
    }

    let editorState;
    if (this.props.element.hasOwnProperty('content')) {
      editorState = this.convertFromHTML(this.props.element.content);
    }
    if (this.props.element.hasOwnProperty('label')) {
      editorState = this.convertFromHTML(this.props.element.label);
    }

    const hideDefault = this.props.element.hideDefaultProperties === true;

    return (
      <div className="inspector-form-container" style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
        
        {/* ── Section: Display Type ── */}
        { this.props.element.custom_metadata?.type && !hideDefault && (
          <div className="inspector-section">
            <div className="inspector-section-title">
              <span className="section-emoji">🎨</span> Display Type
            </div>
            <div className="inspector-field-group">
              <label>UI Element</label>
              <select
                className="inspector-select"
                value={this.state.element.element}
                onChange={(e) => {
                  const newElementType = e.target.value;
                  const this_element = this.state.element;
                  this_element.element = newElementType;
                  
                  if (['Dropdown', 'Checkboxes', 'RadioButtons', 'Tags'].includes(newElementType) && (!this_element.options || this_element.options.length === 0)) {
                    this_element.options = [
                      { value: 'option_1', text: 'Option 1', key: `opt_${Math.random().toString(36).substr(2, 9)}` },
                      { value: 'option_2', text: 'Option 2', key: `opt_${Math.random().toString(36).substr(2, 9)}` }
                    ];
                  }
                  
                  if (newElementType === 'Range') {
                    this_element.min_value = this_element.min_value ?? 0;
                    this_element.max_value = this_element.max_value ?? 100;
                    this_element.step = this_element.step ?? 1;
                  }

                  if (!['Dropdown', 'Checkboxes', 'RadioButtons', 'Tags'].includes(newElementType)) {
                    delete this_element.options;
                  }
                  
                  if (!['NumberInput', 'Range', 'Rating'].includes(newElementType)) {
                    delete this_element.min_value;
                    delete this_element.max_value;
                    delete this_element.step;
                    delete this_element.default_value;
                  }

                  if (['TextInput', 'TextArea', 'Dropdown', 'Checkboxes', 'RadioButtons', 'Tags', 'NumberInput', 'Range', 'Rating'].includes(newElementType)) {
                    this_element.canHaveAnswer = true;
                    this_element.canReadOnly = true;
                    this_element.canHavePageBreakBefore = true;
                    this_element.canHaveAlternateForm = true;
                    this_element.canHaveOptionValue = true;
                    this_element.readOnly = this_element.readOnly ?? false;
                    this_element.required = this_element.required ?? false;
                  }

                  this.setState({ element: this_element, dirty: true }, () => {
                    this.updateElement();
                  });
                }}
              >
                {this.getUIOptions(this.props.element.custom_metadata?.binding?.rmType).map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* ── Section: openEHR Constraints ── */}
        { this.props.element.custom_metadata?.binding?.rmType === 'DV_QUANTITY' && !hideDefault && (
          <div className="inspector-section">
            <div className="inspector-section-title">
              <span className="section-emoji">📏</span> openEHR Constraints
            </div>
            <div className="inspector-field-group">
              <label>Erlaubte Einheiten</label>
              { (!this.props.element.custom_metadata.unitOptions || this.props.element.custom_metadata.unitOptions.length === 0) ? (
                <div style={{ fontSize: '0.8rem', color: '#ef4444', marginTop: '0.25rem', padding: '0.5rem', backgroundColor: '#fef2f2', borderRadius: '4px', border: '1px solid #fecaca' }}>
                  ⚠ Keine erlaubte Einheit gefunden.<br/>Bitte unten eine Einheit manuell hinzufügen.
                </div>
              ) : (
                <table style={{ width: '100%', fontSize: '0.8rem', textAlign: 'left', borderCollapse: 'collapse', marginTop: '0.5rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #e2e8f0', color: '#64748b' }}>
                      <th style={{ padding: '4px' }}>Unit</th>
                      <th style={{ padding: '4px' }}>Min</th>
                      <th style={{ padding: '4px' }}>Max</th>
                      <th style={{ padding: '4px' }}>Prec</th>
                      <th style={{ padding: '4px' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {this.props.element.custom_metadata.unitOptions.map((opt, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '4px', fontWeight: 'bold' }}>{opt.unit}</td>
                        <td style={{ padding: '4px' }}>{opt.min ?? '-'}</td>
                        <td style={{ padding: '4px' }}>{opt.max ?? '-'}</td>
                        <td style={{ padding: '4px' }}>{opt.precision ?? '-'}</td>
                        <td style={{ padding: '4px', textAlign: 'right' }}>
                          <button
                            type="button"
                            className="btn btn-sm btn-link text-danger p-0"
                            style={{ fontSize: '0.75rem', cursor: 'pointer', border: 'none', background: 'none' }}
                            onClick={() => {
                              const this_element = this.state.element;
                              this_element.custom_metadata.unitOptions.splice(i, 1);
                              this.setState({ element: this_element, dirty: true }, () => this.updateElement());
                            }}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.6rem' }}>
                <input
                  type="text"
                  id="new_unit_input"
                  className="inspector-input"
                  placeholder="z.B. cm, kg, m..."
                  style={{ flex: 1, fontSize: '0.8rem' }}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  style={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}
                  onClick={() => {
                    const inputEl = document.getElementById('new_unit_input');
                    const val = inputEl ? inputEl.value.trim() : '';
                    if (val) {
                      const this_element = this.state.element;
                      if (!this_element.custom_metadata.unitOptions) {
                        this_element.custom_metadata.unitOptions = [];
                      }
                      this_element.custom_metadata.unitOptions.push({ unit: val });
                      if (inputEl) inputEl.value = '';
                      this.setState({ element: this_element, dirty: true }, () => this.updateElement());
                    }
                  }}
                >
                  + Einheit
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Section: Label & Text ── */}
        { !hideDefault && (
          <div className="inspector-section">
            <div className="inspector-section-title">
              <span className="section-emoji">✏️</span> Label & Text
            </div>
            {/* Header/Paragraph render `content`, not `label` (see
                formBuilderAdapter.ts's mapItemOrRowToLayoutNode) - editing
                "Field Label" here used to silently do nothing visible,
                since nothing downstream reads a static element's label. */}
            { ['Header', 'Paragraph'].includes(this.state.element.element) ? (
              <div className="inspector-field-group">
                <label>{this.state.element.element === 'Header' ? 'Heading Text' : 'Paragraph Text'}</label>
                {this.state.element.element === 'Header' ? (
                  <input
                    type="text"
                    className="inspector-input"
                    defaultValue={this.props.element.content || ''}
                    onBlur={this.updateElement.bind(this)}
                    onChange={this.editElementProp.bind(this, 'content', 'value')}
                  />
                ) : (
                  <TextAreaAutosize
                    className="inspector-input"
                    minRows={3}
                    defaultValue={this.props.element.content || ''}
                    onBlur={this.updateElement.bind(this)}
                    onChange={this.editElementProp.bind(this, 'content', 'value')}
                  />
                )}
              </div>
            ) : (
              <div className="inspector-field-group">
                <label>Field Label</label>
                <input
                  type="text"
                  className="inspector-input"
                  defaultValue={this.props.element.label || this.props.element.text}
                  onBlur={this.updateElement.bind(this)}
                  onChange={this.editElementProp.bind(this, 'label', 'value')}
                />
              </div>
            )}

            { !['Checkboxes', 'RadioButtons', 'Range', 'Rating', 'Header', 'Paragraph', 'LineBreak'].includes(this.state.element.element) && (
              <div className="inspector-field-group">
                <label>Placeholder</label>
                <input
                  type="text"
                  className="inspector-input"
                  placeholder="e.g. Select... or Enter value..."
                  defaultValue={this.props.element.placeholder || ''}
                  onBlur={this.updateElement.bind(this)}
                  onChange={this.editElementProp.bind(this, 'placeholder', 'value')}
                />
              </div>
            )}

            { !['Header', 'Paragraph', 'LineBreak'].includes(this.state.element.element) && (
              <div className="inspector-field-group">
                <label>Help Text</label>
                <textarea
                  className="inspector-input"
                  rows={2}
                  style={{ resize: 'vertical', minHeight: '48px' }}
                  placeholder="Instruction shown below the field"
                  defaultValue={this.props.element.description || ''}
                  onBlur={this.updateElement.bind(this)}
                  onChange={this.editElementProp.bind(this, 'description', 'value')}
                />
              </div>
            )}
          </div>
        )}

        {/* ── Section: Behavior ── */}
        { !['Header', 'Paragraph', 'LineBreak'].includes(this.state.element.element) && !hideDefault && (
          <div className="inspector-section">
            <div className="inspector-section-title">
              <span className="section-emoji">⚙️</span> Behavior
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <label className="inspector-checkbox-row">
                <input 
                  type="checkbox" 
                  checked={this_checked} 
                  onChange={this.editElementProp.bind(this, 'required', 'checked')} 
                />
                <span className="inspector-checkbox-label">
                  Required { this.props.element.custom_metadata?.binding ? <span style={{ fontSize: '0.65rem', color: '#94a3b8', fontStyle: 'italic', fontWeight: 400 }}>(openEHR)</span> : '' }
                </span>
              </label>

              <label className="inspector-checkbox-row">
                <input 
                  type="checkbox" 
                  checked={this_read_only} 
                  onChange={this.editElementProp.bind(this, 'readOnly', 'checked')} 
                />
                <span className="inspector-checkbox-label">Read-only</span>
              </label>

              <label className="inspector-checkbox-row">
                <input 
                  type="checkbox" 
                  checked={this.props.element.hidden || false} 
                  onChange={this.editElementProp.bind(this, 'hidden', 'checked')} 
                />
                <span className="inspector-checkbox-label">Hidden by default</span>
              </label>
            </div>
          </div>
        )}

        {/* ── Section: Scale / Range ── */}
        { this.state.element.element === 'Range' && !hideDefault && (
          <div className="inspector-section">
            <div className="inspector-section-title">
              <span className="section-emoji">📊</span> Scale Config
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem' }}>
              <div className="inspector-field-group">
                <label>Min</label>
                <input type="number" className="inspector-input" defaultValue={this.props.element.min_value} onBlur={this.updateElement.bind(this)} onChange={this.editElementProp.bind(this, 'min_value', 'value')} />
              </div>
              <div className="inspector-field-group">
                <label>Max</label>
                <input type="number" className="inspector-input" defaultValue={this.props.element.max_value} onBlur={this.updateElement.bind(this)} onChange={this.editElementProp.bind(this, 'max_value', 'value')} />
              </div>
              <div className="inspector-field-group">
                <label>Step</label>
                <input type="number" className="inspector-input" defaultValue={this.props.element.step} onBlur={this.updateElement.bind(this)} onChange={this.editElementProp.bind(this, 'step', 'value')} />
              </div>
            </div>
          </div>
        )}

        {/* ── Section: Options / Choices ── */}
        { this.props.element.options && !hideDefault && (
          <div className="inspector-section" style={{ gap: '0.5rem' }}>
            <div className="inspector-section-title" style={{ marginBottom: 0 }}>
              <span className="section-emoji">📋</span> Choices
            </div>
            
            <div className="inspector-options-list-wrapper">
              <DynamicOptionList 
                showCorrectColumn={false}
                canHaveOptionCorrect={false}
                canHaveOptionValue={true}
                data={this.props.preview?.state?.data || []}
                updateElement={this.props.updateElement}
                preview={this.props.preview}
                element={this.props.element}
                key={this.props.element.options.length} 
              />
            </div>
          </div>
        )}
      </div>
    );
  }
}
FormElementsEdit.defaultProps = { className: 'edit-element-fields' };
