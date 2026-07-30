/* eslint-disable camelcase */
import React, { useEffect, useState } from "react";

import FieldsetDustbin from '../multi-column/dustbin';
import ItemTypes from "../ItemTypes";
import DragHandle from "../form-elements/component-drag-handle";
import store from "../stores/store";

const accepts = [ItemTypes.BOX, ItemTypes.CARD];

export default function FieldSetBase(props) {
  
  const [childData, setChildData] = useState({});
  const [childItems, setChildItems] = useState(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const { data, class_name, ...rest } = props;
    setChildData(data);
    let count = 1;
    createChild(count, data);
    setCollapsed(data.custom_metadata?.initiallyCollapsed === true);
  }, [props]);


  const addNewChild = () => {
    let data = props.data;
    let colCount = data.childItems.length + 1;
    let oldChilds = data.childItems;
    data.childItems = Array.from({ length: colCount }, (v, i) => { return oldChilds[i] ? oldChilds[i] : null });

    setChildItems(data.childItems);
  }

  const onDropSuccess = (droppedIndex) => {
    const totalChild = childItems ? childItems.length : 0;
    const isLastChild = totalChild === droppedIndex + 1;
   
    if (isLastChild) {
      addNewChild();
    }
  }

  const moveGroupCard = (dragIndex, hoverIndex) => {
    if (!childItems) return;
    const newItems = [...childItems];
    const dragItemId = newItems[dragIndex];
    newItems[dragIndex] = newItems[hoverIndex];
    newItems[hoverIndex] = dragItemId;

    setChildItems(newItems);
    props.data.childItems = newItems;

    if (newItems[dragIndex]) {
      const item1 = getDataById(newItems[dragIndex]);
      if (item1) item1.col = dragIndex;
    }
    if (newItems[hoverIndex]) {
      const item2 = getDataById(newItems[hoverIndex]);
      if (item2) item2.col = hoverIndex;
    }

    store.dispatch('updateOrder', store.state.data);
  };
  
  const createChild = (count, data) => {
    const colCount = count;
    const className = data.class_name || "col-md-12";
    if (!data.childItems) {
      // eslint-disable-next-line no-param-reassign
      data.childItems = Array.from({ length: colCount }, (v, i) => null);
      data.isContainer = true;
    }
    setChildItems(data.childItems);
  };

  const {
    controls,
    editModeOn,
    getDataById,
    getIndexById,
    moveCard,
    insertCard,
    setAsChild,
    removeChild,
    seq,
    className,
    index,
  } = props;

  const { pageBreakBefore } = childData;
  let baseClasses = "SortableItem rfb-item";
  if (pageBreakBefore) {
    baseClasses += " alwaysbreak";
  }

  const isCollapsible = childData.custom_metadata?.collapsible === true;
  const fieldCount = childItems ? childItems.filter(x => x !== null && x !== undefined).length : 0;
  const groupLabel = childData.label || childData.text || 'Group Container';
  const technicalName = childData.custom_metadata?.technicalName || childData.field_name || childData.id || 'group_container';

  const toggleCollapse = () => {
    if (isCollapsible) {
      setCollapsed(!collapsed);
    }
  };

  return (
    <div style={{ ...props.style }} className={`${baseClasses} group-fieldset-container ${collapsed ? 'collapsed' : ''}`}>
      {/* Premium Group Container Header */}
      <div 
        className="group-container-header" 
        onClick={isCollapsible ? toggleCollapse : undefined} 
        style={{ cursor: isCollapsible ? 'pointer' : 'default' }}
      >
        <div className="group-header-info">
          <div className="group-title">
            📁 {groupLabel}
            {isCollapsible && (
              <span className="collapse-arrow-icon" style={{ marginLeft: '0.4rem', fontSize: '0.78rem', color: '#64748b' }}>
                <i className={collapsed ? "fas fa-chevron-right" : "fas fa-chevron-down"}></i>
              </span>
            )}
          </div>
          <div className="group-subtitle">
            <span className="group-tech-id">{technicalName}</span>
            <span className="status-dot-sep">·</span>
            <span className="group-fields-count">{fieldCount} fields</span>
          </div>
        </div>
        
        <div className="group-header-actions" onClick={e => e.stopPropagation()}>
          {/* Collapse Button */}
          {isCollapsible && (
            <button 
              type="button" 
              className="btn-group-action"
              title={collapsed ? "Expand Group" : "Collapse Group"}
              onClick={toggleCollapse}
            >
              <i className={collapsed ? "fas fa-chevron-right" : "fas fa-chevron-down"}></i>
            </button>
          )}

          {/* Group Settings Button (Edit) */}
          <button 
            type="button" 
            className="btn-group-action"
            title="Group Settings"
            onClick={() => editModeOn(props.parent, props.data)}
          >
            <i className="fas fa-edit"></i>
          </button>

          {/* Delete Button */}
          <button 
            type="button" 
            className="btn-group-action delete"
            title="Delete Group"
            onClick={() => props._onDestroy(props.data)}
          >
            <i className="fas fa-trash"></i>
          </button>

          {/* Drag Handle */}
          <DragHandle
            data={props.data}
            index={props.index}
            onDestroy={props._onDestroy}
            setAsChild={props.setAsChild}
          />
        </div>
      </div>

      {/* Group Children Content */}
      <div className="group-container-content" style={{ display: collapsed ? 'none' : 'block' }}>
        <div className="row">        
          {childItems?.map((x, i) => (
            <div key={`${i}_${x || "_"}`} className={"col-md-12"}>
              {controls ? (
                controls[i]
              ) : (
                <FieldsetDustbin
                  style={{ width: "100%" }}
                  data={childData}
                  accepts={accepts}
                  items={childItems}
                  key={i}
                  col={i}
                  onDropSuccess={() => onDropSuccess(i)}
                  parentIndex={index}
                  editModeOn={editModeOn}
                  _onDestroy={() => removeChild(childData, i)}
                  getDataById={getDataById}
                  getIndexById={getIndexById}
                  moveCard={moveGroupCard}
                  insertCard={insertCard}
                  setAsChild={setAsChild}
                  removeChild={removeChild}
                  seq={seq}
                  rowNo={i}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
