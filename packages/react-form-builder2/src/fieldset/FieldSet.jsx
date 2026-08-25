/* eslint-disable camelcase */
import React, { useEffect, useState } from 'react';

import FieldsetDustbin from '../multi-column/dustbin';
import ItemTypes from '../ItemTypes';
import DragHandle from '../form-elements/component-drag-handle';
import store from '../stores/store';

const accepts = [ItemTypes.BOX, ItemTypes.CARD];

export default function FieldSetBase(props) {
  const [childData, setChildData] = useState({});
  const [childItems, setChildItems] = useState(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const { data } = props;
    setChildData(data);
    createChild(1, data);
    setCollapsed(data.custom_metadata?.initiallyCollapsed === true);
  }, [props]);

  const addNewChild = () => {
    const data = props.data;
    const colCount = data.childItems.length + 1;
    const oldChilds = data.childItems;
    data.childItems = Array.from({ length: colCount }, (_, index) => oldChilds[index] || null);
    setChildItems(data.childItems);
  };
  const onDropSuccess = (droppedIndex) => {
    const totalChild = childItems ? childItems.length : 0;
    if (totalChild === droppedIndex + 1) addNewChild();
  };
  const moveGroupCard = (dragIndex, hoverIndex) => {
    if (!childItems) return;
    const newItems = [...childItems];
    const dragItemId = newItems[dragIndex];
    newItems[dragIndex] = newItems[hoverIndex];
    newItems[hoverIndex] = dragItemId;
    setChildItems(newItems);
    props.data.childItems = newItems;
    if (newItems[dragIndex]) { const item = getDataById(newItems[dragIndex]); if (item) item.col = dragIndex; }
    if (newItems[hoverIndex]) { const item = getDataById(newItems[hoverIndex]); if (item) item.col = hoverIndex; }
    store.dispatch('updateOrder', store.state.data);
  };
  const createChild = (count, data) => {
    const className = data.class_name || 'col-md-12';
    void className;
    if (!data.childItems) { data.childItems = Array.from({ length: count }, () => null); data.isContainer = true; }
    setChildItems(data.childItems);
  };

  const { controls, editModeOn, getDataById, getIndexById, moveCard, insertCard, setAsChild, removeChild, seq, index } = props;
  const isProtectedRoot = childData.custom_metadata?.protectedRoot === true;
  const isCollapsible = childData.custom_metadata?.collapsible === true;
  const fieldCount = childItems ? childItems.filter((item) => item !== null && item !== undefined).length : 0;
  const groupLabel = childData.label || childData.text || 'Group Container';
  const technicalName = childData.custom_metadata?.technicalName || childData.field_name || childData.id || 'group_container';
  const toggleCollapse = () => { if (isCollapsible) setCollapsed(!collapsed); };

  return <div style={{ ...props.style }} className={`SortableItem rfb-item group-fieldset-container ${collapsed ? 'collapsed' : ''} ${isProtectedRoot ? 'composition-page-root' : ''}`}>
    <div className="group-container-header" onClick={isCollapsible ? toggleCollapse : undefined} style={{ cursor: isCollapsible ? 'pointer' : 'default' }}>
      <div className="group-header-info"><div className="group-title">{isProtectedRoot ? '▣' : '📁'} {groupLabel}</div><div className="group-subtitle"><span className="group-tech-id">{isProtectedRoot ? 'Composition-Seite' : technicalName}</span><span className="status-dot-sep">·</span><span className="group-fields-count">{fieldCount} Elemente</span></div></div>
      {!isProtectedRoot && <div className="group-header-actions" onClick={(event) => event.stopPropagation()}>
        {isCollapsible && <button type="button" className="btn-group-action" title={collapsed ? 'Expand Group' : 'Collapse Group'} onClick={toggleCollapse}><i className={collapsed ? 'fas fa-chevron-right' : 'fas fa-chevron-down'} /></button>}
        <button type="button" className="btn-group-action" title="Group Settings" onClick={() => editModeOn(props.parent, props.data)}><i className="fas fa-edit" /></button>
        <button type="button" className="btn-group-action delete" title="Delete Group" onClick={() => props._onDestroy(props.data)}><i className="fas fa-trash" /></button>
        <DragHandle data={props.data} index={props.index} onDestroy={props._onDestroy} setAsChild={props.setAsChild} />
      </div>}
    </div>
    <div className="group-container-content" style={{ display: collapsed ? 'none' : 'block' }}><div className="row">{childItems?.map((item, childIndex) => <div key={`${childIndex}_${item || '_'}`} className="col-md-12">{controls ? controls[childIndex] : <FieldsetDustbin style={{ width: '100%' }} data={childData} accepts={accepts} items={childItems} col={childIndex} onDropSuccess={() => onDropSuccess(childIndex)} parentIndex={index} editModeOn={editModeOn} _onDestroy={() => removeChild(childData, childIndex)} getDataById={getDataById} getIndexById={getIndexById} moveCard={moveGroupCard} insertCard={insertCard} setAsChild={setAsChild} removeChild={removeChild} seq={seq} rowNo={childIndex} />}</div>)}</div></div>
  </div>;
}
