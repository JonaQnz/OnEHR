import React, { useRef, useState } from 'react';
import { useDrop } from 'react-dnd';
import FormElements from '../sortable-form-elements';
import ItemTypes from '../ItemTypes';

import CustomElement from '../form-elements/custom-element';
import Registry from '../stores/registry';
import store from '../stores/store';

function getCustomElement(item, props) {
  if (!item.component || typeof item.component !== 'function') {
    item.component = Registry.get(item.key);
    if (!item.component) {
      console.error(`${item.element} was not registered`);
    }
  }
  return (
    <CustomElement
      {...props}
      mutable={false}
      key={`form_${item.id}`}
      data={item}
    />
  );
}

function getElement(item, props, getDataById, getIndexById, setAsChild, seq) {
  if (!item) return null;
  if (item.custom) {
    return getCustomElement(item, props);
  }
  const Element = FormElements[item.element || item.key];
  return (
    <Element 
      {...props} 
      getDataById={getDataById}
      id={item.id}
      index={item.parentId ? props.rowNo : (typeof getIndexById === 'function' ? getIndexById(item.id) : -1)}
      moveCard={props.moveCard}
      insertCard={props.insertCard}
      setAsChild={setAsChild} 
      seq={seq} 
      key={`form_${item.id}`} 
      data={item} 
    />
  );
}

function getStyle(backgroundColor, hasElement, isOver, canDrop) {
  let border = '1px dashed #cbd5e1';
  let currentBg = backgroundColor;
  
  if (isOver && canDrop) {
    border = '2px dashed #3b82f6';
    currentBg = 'rgba(59, 130, 246, 0.08)';
  } else if (hasElement) {
    border = 'none';
    currentBg = 'transparent';
  }
  
  return {
    border,
    minHeight: hasElement ? 'auto' : '3.5rem',
    minWidth: '7rem',
    width: '100%',
    backgroundColor: currentBg,
    padding: hasElement ? '4px' : '0.5rem',
    borderRadius: '6px',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#94a3b8',
    fontSize: '0.8rem',
    transition: 'all 0.2s ease',
  };
}

function isContainer(item) {
  const data = item.data;
  if (data) {
    if (data.isContainer) {
      return true;
    }
    if (data.field_name && data.field_name.indexOf('_col_row') > -1) {
      return true;
    }
    if (data.element && data.element.indexOf('ColumnRow') > -1) {
      return true;
    }
  }
  return false;
}

const Dustbin = ({
  onDropSuccess,
  seq,
  parentIndex,
  items,
  col,
  getDataById,
  getIndexById,
  accepts,
  data,
  setAsChild,
  ...rest
}) => {
  const dropRef = useRef(null);
  const [hoverDirection, setHoverDirection] = useState(null);
  const item = getDataById(items[col]);

  const [{ isOver, canDrop, draggedItem }, drop] = useDrop({
    accept: accepts,
    collect: (monitor) => ({
      isOver: monitor.isOver({ shallow: true }),
      canDrop: monitor.canDrop(),
      draggedItem: monitor.getItem(),
    }),
    drop: (droppedItem, monitor) => {
      if (monitor.didDrop()) return undefined;
      // Do nothing when moving the box inside the same column
      if (col === droppedItem.col && items[col] === droppedItem.id) return { destination: data?.id };

      const isParentFieldSet = data && data.element === 'FieldSet';
      if (!isContainer(droppedItem) || isParentFieldSet) {
        const isBusy = !!items[col];

        if (droppedItem.data) {
          const isNew = !droppedItem.data.id;
          const itemData = isNew ? droppedItem.onCreate(droppedItem.data) : droppedItem.data;

          const moved = typeof setAsChild === 'function'
            && setAsChild(data, itemData, col, isBusy);
          if (!moved) return { destination: data?.id, rejected: true };
          onDropSuccess && onDropSuccess();

          // Only delete lastItem if it refers to a different item that was
          // temporarily inserted on the flat canvas during hover. If lastItem
          // IS this item (same id), deleting it would make the item vanish.
          const lastItem = store.state?.lastItem;
          if (isNew && lastItem && lastItem.id !== itemData.id) {
            store.dispatch('deleteLastItem');
          } else {
            store.dispatch('resetLastItem');
          }
          return { destination: data?.id };
        }
      }
      return { destination: data?.id, rejected: true };
    },
    hover: (dragged, monitor) => {
      if (!monitor.isOver({ shallow: true }) || !dropRef.current) return;
      const rect = dropRef.current.getBoundingClientRect();
      const offset = monitor.getClientOffset();
      if (!offset) return;
      setHoverDirection(offset.y < rect.top + (rect.height / 2) ? 'top' : 'bottom');
    },
    canDrop: (dragged) => {
      const draggedData = dragged?.data;
      if (!draggedData || !data || draggedData.id === data.id) return false;
      if (isContainer(dragged) && data.element !== 'FieldSet') return false;

      // A group may not be dropped into itself or one of its descendants.
      let ancestor = data;
      while (ancestor?.parentId) {
        ancestor = getDataById(ancestor.parentId);
        if (!ancestor || ancestor.id === draggedData.id) return false;
      }

      const occupiedId = items[col];
      return !occupiedId
        || occupiedId === draggedData.id
        || (draggedData.parentId === data.id && items.includes(draggedData.id));
    },
  });

  const element = getElement(item, rest, getDataById, getIndexById, setAsChild, seq);
  const sameCard = draggedItem ? draggedItem.index === parentIndex : false;

  let backgroundColor = 'rgba(0, 0, 0, .03)';

  const isParentFieldSet = data && data.element === 'FieldSet';
  if (!sameCard && isOver && canDrop && draggedItem && (!draggedItem.data?.isContainer || isParentFieldSet)) {
    backgroundColor = '#F7F589';
  }

  // Connect the drop ref to the DOM element
  drop(dropRef);

  return (
    <div ref={dropRef} style={{ ...(!sameCard ? getStyle(backgroundColor, !!element, isOver, canDrop) : getStyle('rgba(0, 0, 0, .03)', !!element, false, false)), position: 'relative' }}>
      {!sameCard && isOver && canDrop && hoverDirection === 'top' && <div className="dnd-insertion-line top" />}
      {!element && <span style={{ pointerEvents: 'none' }}>Drop your element here</span>}
      {element}
      {!sameCard && isOver && canDrop && hoverDirection === 'bottom' && <div className="dnd-insertion-line bottom" />}
    </div>
  );
};

export default Dustbin;
