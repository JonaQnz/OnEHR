/**
  * <Preview />
  */

import React from 'react';
import update from 'immutability-helper';
import store from './stores/store';
import FormElementsEdit from './form-dynamic-edit';
import SortableFormElements from './sortable-form-elements';
import CustomDragLayer from './form-elements/component-drag-layer';

const { PlaceHolder } = SortableFormElements;

export default class Preview extends React.Component {
  state = {
    data: [],
    answer_data: {},
  };

  constructor(props) {
    super(props);

    const { onLoad, onPost } = props;
    store.setExternalHandler(onLoad, onPost);

    this.editForm = React.createRef();
    this.state = {
      data: props.data || [],
      answer_data: {},
    };
    this.seq = 0;

    this._onUpdate = this._onChange.bind(this);
    this.getDataById = this.getDataById.bind(this);
    this.getIndexById = this.getIndexById.bind(this);
    this.moveCard = this.moveCard.bind(this);
    this.insertCard = this.insertCard.bind(this);
    this.setAsChild = this.setAsChild.bind(this);
    this.removeChild = this.removeChild.bind(this);
    this._onDestroy = this._onDestroy.bind(this);
  }

  componentDidMount() {
    const { data, url, saveUrl, saveAlways } = this.props;
    store.subscribe(state => this._onUpdate(state.data));
    store.dispatch('load', { loadUrl: url, saveUrl, data: data || [], saveAlways });
    document.addEventListener('mousedown', this.editModeOff);
  }

  componentWillUnmount() {
    document.removeEventListener('mousedown', this.editModeOff);
  }

  editModeOff = (e) => {
    if (this.editForm.current && !this.editForm.current.contains(e.target)) {
      this.manualEditModeOff();
    }
  }

  manualEditModeOff = () => {
    const { editElement } = this.props;
    if (editElement && editElement.dirty) {
      editElement.dirty = false;
      this.updateElement(editElement);
    }
    this.props.manualEditModeOff();
  }

  _setValue(text) {
    return text.replace(/[^A-Z0-9]+/ig, '_').toLowerCase();
  }

  updateElement(element) {
    const { data } = this.state;
    let found = false;

    for (let i = 0, len = data.length; i < len; i++) {
      if (element.id === data[i].id) {
        data[i] = element;
        found = true;
        break;
      }
    }

    if (found) {
      this.seq = this.seq > 100000 ? 0 : this.seq + 1;
      store.dispatch('updateOrder', data);
    }
  }

  _onChange(data) {
    const answer_data = {};

    data.forEach((item) => {
      if (item && item.readOnly && this.props.variables[item.variableKey]) {
        answer_data[item.field_name] = this.props.variables[item.variableKey];
      }
    });

    this.setState({
      data,
      answer_data,
    });
  }

  _onDestroy(item) {
    if (item.childItems) {
      item.childItems.forEach(x => {
        const child = this.getDataById(x);
        if (child) {
          store.dispatch('delete', child);
        }
      });
    }
    store.dispatch('delete', item);
  }

  getDataById(id) {
    const { data } = this.state;
    return data.find(x => x && x.id === id);
  }

  getIndexById(id) {
    return this.state.data.findIndex(x => x && x.id === id);
  }

  swapChildren(data, item, child, col) {
    const oldCol = item.childItems.indexOf(child.id);
    if (child.parentId !== item.id || oldCol === -1 || oldCol === col || !item.childItems[col]) return false;
    const oldId = item.childItems[col];
    const oldItem = this.getDataById(oldId);
    if (!oldItem) return false;
    // eslint-disable-next-line no-param-reassign
    item.childItems[oldCol] = oldId; oldItem.col = oldCol;
    // eslint-disable-next-line no-param-reassign
    item.childItems[col] = child.id; child.col = col;
    store.dispatch('updateOrder', data);
    return true;
  }

  setAsChild(item, child, col, isBusy) {
    const { data } = this.state;
    if (!item || !child || item.id === child.id || !Array.isArray(item.childItems)) return false;
    let ancestor = item;
    while (ancestor?.parentId) {
      ancestor = this.getDataById(ancestor.parentId);
      if (!ancestor || ancestor.id === child.id) {
        return false;
      }
    }
    if (this.swapChildren(data, item, child, col)) {
      return true;
    }
    if (isBusy && item.childItems[col] !== child.id) {
      return false;
    }

    // Enforce one parent slot per item. Removing stale references before the
    // insertion prevents duplicate rendering after moves across nested groups.
    data.forEach((candidate) => {
      if (Array.isArray(candidate?.childItems)) {
        candidate.childItems = candidate.childItems.map(id => (id === child.id ? null : id));
      }
    });
    item.childItems[col] = child.id;
    child.col = col;
    child.parentId = item.id;
    child.parentIndex = data.indexOf(item);
    const newData = [...data];
    if (!this.getDataById(child.id)) {
      newData.push(child);
    }
    store.dispatch('updateOrder', newData);
    return true;
  }

  removeChild(item, col) {
    const { data } = this.state;
    const oldId = item.childItems[col];
    const oldItem = this.getDataById(oldId);
    if (oldItem) {
      const newData = data.filter(x => x !== oldItem);
      // eslint-disable-next-line no-param-reassign
      item.childItems[col] = null;
      // delete oldItem.parentId;
      this.seq = this.seq > 100000 ? 0 : this.seq + 1;
      store.dispatch('updateOrder', newData);
      this.setState({ data: newData });
    }
  }

  restoreCard(item, id, hoverIndex) {
    const { data } = this.state;
    const oldItem = this.getDataById(id);
    if (!oldItem) return;
    data.forEach((candidate) => {
      if (Array.isArray(candidate?.childItems)) {
        candidate.childItems = candidate.childItems.map(childId => (childId === oldItem.id ? null : childId));
      }
    });
    delete oldItem.parentId;
    delete oldItem.parentIndex;
    delete oldItem.col;
    const newData = data.filter(x => x !== oldItem);
    newData.splice(Math.max(0, Math.min(hoverIndex, newData.length)), 0, oldItem);
    this.seq = this.seq > 100000 ? 0 : this.seq + 1;
    store.dispatch('updateOrder', newData);
    this.setState({ data: newData });
  }

  insertCard(item, hoverIndex, id) {
    const { data } = this.state;
    if (id) {
      this.restoreCard(item, id, hoverIndex);
    } else {
      const newData = [...data];
      newData.splice(Math.max(0, Math.min(hoverIndex, newData.length)), 0, item);
      this.setState({ data: newData });
      store.dispatch('updateOrder', newData);
      store.dispatch('insertItem', item);
    }
  }

  moveCard(dragIndex, hoverIndex) {
    const { data } = this.state;
    const dragCard = data[dragIndex];
    // happens sometimes when you click to insert a new item from the toolbox
    if (dragCard !== undefined) {
      this.saveData(dragCard, dragIndex, hoverIndex);
    }
  }

  // eslint-disable-next-line no-unused-vars
  cardPlaceHolder(dragIndex, hoverIndex) {
    // Dummy
  }

  saveData(dragCard, dragIndex, hoverIndex) {
    const newData = update(this.state, {
      data: {
        $splice: [[dragIndex, 1], [hoverIndex, 0, dragCard]],
      },
    });
    this.setState(newData);
    store.dispatch('updateOrder', newData.data);
  }

  getElement(item, index) {
    if (item.custom) {
      if (!item.component || typeof item.component !== 'function') {
        const restoredComponent = this.props.registry.get(item.key);
        // eslint-disable-next-line no-param-reassign
        item.component = restoredComponent;
      }
    }
    const SortableFormElement = SortableFormElements[item.element];

    if (SortableFormElement === null) {
      return null;
    }
    return <SortableFormElement id={item.id} seq={this.seq} index={index} moveCard={this.moveCard} insertCard={this.insertCard} mutable={false} parent={this.props.parent} editModeOn={this.props.editModeOn} isDraggable={true} key={item.id} sortData={item.id} data={item} getDataById={this.getDataById} getIndexById={this.getIndexById} setAsChild={this.setAsChild} removeChild={this.removeChild} _onDestroy={this._onDestroy} />;
  }

  showEditForm() {
    const handleUpdateElement = (element) => this.updateElement(element);
    handleUpdateElement.bind(this);

    const formElementEditProps = {
      showCorrectColumn: this.props.showCorrectColumn,
      files: this.props.files,
      manualEditModeOff: this.manualEditModeOff,
      preview: this,
      element: this.props.editElement,
      updateElement: handleUpdateElement,
    };

    return this.props.renderEditForm(formElementEditProps);
  }

  render() {
    let classes = this.props.className;
    if (this.props.editMode) { classes += ' is-editing'; }
    const data = this.state.data.filter(x => !!x && !x.parentId);
    const items = data.map((item, index) => this.getElement(item, index));
    return (
      <div className={classes}>
        <div className="edit-form" ref={this.editForm}>
          {this.props.editElement !== null && this.showEditForm()}
        </div>
        <div className="Sortable">{items}</div>
        <PlaceHolder id="form-place-holder" show={items.length === 0} index={items.length} moveCard={this.cardPlaceHolder} insertCard={this.insertCard} />
        <CustomDragLayer/>
      </div>
    );
  }
}
Preview.defaultProps = {
  showCorrectColumn: false,
  files: [],
  editMode: false,
  editElement: null,
  className: 'col-md-9 react-form-builder-preview float-left',
  renderEditForm: props => <FormElementsEdit {...props} />,
};
