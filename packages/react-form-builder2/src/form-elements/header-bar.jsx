/**
 * <HeaderBar />
 */

import React from 'react';
import DragHandle from './component-drag-handle';
import store from '../stores/store';

function getTypeIcon(element) {
  if (element === 'FieldSet') return 'fas fa-folder';
  if (element === 'TextInput') return 'fas fa-font';
  if (element === 'NumberInput') return 'fas fa-hashtag';
  if (element === 'Dropdown') return 'fas fa-chevron-down';
  if (element === 'DatePicker') return 'fas fa-calendar-alt';
  if (element === 'Checkboxes') return 'fas fa-check-square';
  if (element === 'RadioButtons') return 'fas fa-dot-circle';
  if (element === 'TextArea') return 'fas fa-align-left';
  if (element === 'Paragraph') return 'fas fa-paragraph';
  if (element === 'Header') return 'fas fa-heading';
  if (element === 'LineBreak') return 'fas fa-arrows-alt-h';
  if (element === 'TwoColumnRow' || element === 'ThreeColumnRow' || element === 'MultiColumnRow') return 'fas fa-columns';
  return 'fas fa-cog';
}

function getRmTypeEmoji(rmType) {
  if (!rmType) return '📝';
  const type = rmType.toUpperCase();
  if (type.includes('TEXT')) return '🔤'; // DV_TEXT, DV_CODED_TEXT
  if (type.includes('QUANTITY') || type.includes('PROPORTION')) return '⚖️'; // DV_QUANTITY, DV_PROPORTION
  if (type.includes('COUNT') || type.includes('INTEGER')) return '🔢'; // DV_COUNT, INTEGER
  if (type.includes('DATE') || type.includes('TIME')) return '📅'; // DV_DATE_TIME, DV_DATE
  if (type.includes('BOOLEAN')) return '☑️'; // DV_BOOLEAN
  if (type.includes('IDENTIFIER')) return '🆔'; // DV_IDENTIFIER
  if (type.includes('URI')) return '🔗'; // DV_URI
  if (type.includes('MULTIMEDIA')) return '🖼️'; // DV_MULTIMEDIA
  if (type.includes('CHOICE') || type.includes('CODED')) return '🗂️';
  return '📝';
}

function getTypeLabel(element) {
  if (element === 'FieldSet') return 'Group';
  if (element === 'TextInput') return 'Text';
  if (element === 'NumberInput') return 'Number';
  if (element === 'Dropdown') return 'Select';
  if (element === 'DatePicker') return 'Date';
  if (element === 'Checkboxes') return 'Checkbox';
  if (element === 'RadioButtons') return 'Radio';
  if (element === 'TextArea') return 'Textarea';
  if (element === 'Paragraph') return 'Paragraph';
  if (element === 'Header') return 'Header';
  if (element === 'LineBreak') return 'Divider';
  if (element && element.includes('Column')) return 'Layout';
  return element || '';
}

export default class HeaderBar extends React.Component {
  render() {
    const element = this.props.data.element;
    const iconClass = getTypeIcon(element);
    const label = getTypeLabel(element);
    const isContainerOrStatic = ['FieldSet', 'TwoColumnRow', 'ThreeColumnRow', 'MultiColumnRow', 'Header', 'Paragraph', 'LineBreak'].includes(element);

    const hasRequiredLabel =
      this.props.data.hasOwnProperty('required') &&
      this.props.data.required === true;
    const labelText = this.props.data.label || 'Field Label';

    const rmType = this.props.data.custom_metadata?.binding?.rmType;
    const emoji = getRmTypeEmoji(rmType);

    const index = this.props.index;
    const parentId = this.props.data.parentId;

    return (
      <div className={`toolbar-header field-title-bar ${isContainerOrStatic ? 'container-title-bar' : 'input-title-bar'}`}>
        {!isContainerOrStatic ? (
          <div className="field-title-info">
            <span className="field-title-emoji" style={{ marginRight: '0.2rem' }}>{emoji}</span>
            <span className="field-title-text" dangerouslySetInnerHTML={{ __html: labelText }} />
            {hasRequiredLabel && (
              <span className="label-required badge badge-danger">Required</span>
            )}
          </div>
        ) : (
          <span className="badge badge-secondary type-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
            <i className={iconClass} style={{ fontSize: '0.75rem', opacity: 0.7 }}></i>
            <span style={{ fontStyle: 'italic', fontWeight: 500, opacity: 0.8 }}>{label}:</span>
            <span style={{ fontWeight: 700 }}>{this.props.data.label || this.props.data.text?.replace(/^[^:]+:\s*/, '') || ''}</span>
          </span>
        )}
        <div className="toolbar-header-buttons">
          {this.props.moveCard && index > 0 && (
            <div
              className="btn is-isolated"
              title="Move Up"
              onClick={() => this.props.moveCard(index, index - 1)}
            >
              <i className="is-isolated fas fa-chevron-up"></i>
            </div>
          )}
          {this.props.moveCard && (
            <div
              className="btn is-isolated"
              title="Move Down"
              onClick={() => {
                if (parentId) {
                  this.props.moveCard(index, index + 1);
                } else {
                  const total = store.state?.data?.length || 100;
                  if (index + 1 < total) {
                    this.props.moveCard(index, index + 1);
                  }
                }
              }}
            >
              <i className="is-isolated fas fa-chevron-down"></i>
            </div>
          )}
          {this.props.data.element !== 'LineBreak' && (
            <div
              className="btn is-isolated"
              onClick={this.props.editModeOn.bind(
                this.props.parent,
                this.props.data
              )}
            >
              <i className="is-isolated fas fa-edit"></i>
            </div>
          )}
          <div
            className="btn is-isolated delete"
            onClick={this.props.onDestroy.bind(this, this.props.data)}
          >
            <i className="is-isolated fas fa-trash"></i>
          </div>

          <DragHandle
            data={this.props.data}
            index={this.props.index}
            onDestroy={this.props.onDestroy}
            setAsChild={this.props.setAsChild}
          />
        </div>
      </div>
    );
  }
}
