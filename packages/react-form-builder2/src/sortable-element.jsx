import React, { useRef } from 'react';
import PropTypes from 'prop-types';
import { useDrag, useDrop } from 'react-dnd';
import ItemTypes from './ItemTypes';

const style = {
  cursor: 'pointer',
};

// Modern approach using a custom hook for DnD logic
const useDragAndDrop = (props) => {
  const ref = useRef(null);
  const [hoverDir, setHoverDir] = React.useState(null); // 'top' | 'bottom' | null
  
  // Setup drag
  const [{ isDragging }, drag, preview] = useDrag({
    type: ItemTypes.CARD,
    // Composition pages are protected roots: they accept children but cannot
    // themselves be dragged out of the only valid page container.
    canDrag: () => props.data?.custom_metadata?.protectedRoot !== true,
    item: () => ({
      itemType: ItemTypes.CARD,
      id: props.id,
      index: props.index,
      parentId: props.data?.parentId,
      data: props.data,
    }),
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  });

  // Setup drop
  const [{ isOver, canDrop }, drop] = useDrop({
    accept: [ItemTypes.CARD, ItemTypes.BOX],
    collect: (monitor) => ({
      isOver: monitor.isOver({ shallow: true }),
      canDrop: monitor.canDrop(),
    }),
    drop: (item, monitor) => {
      // React DnD bubbles a nested Dustbin's drop up to every outer sortable
      // card wrapping it (a TwoColumnRow/ThreeColumnRow/FieldSet card is
      // itself rendered as a top-level SortableFormElement, with its column
      // Dustbins nested inside that same DOM subtree). `monitor.didDrop()`
      // is meant to guard against replaying an already-handled drop, but
      // relying on it alone here raced the Dustbin's own drop in practice -
      // confirmed live: dropping a template field into a row's column
      // intermittently either silently deleted the whole row (this outer
      // handler firing a SECOND, real insertCard() at the row's own index
      // with a fresh onCreate() id, immediately followed by another engine
      // recomputing this card's own position and orphaning it) or hung the
      // tab outright (setAsChild's ancestor walk looping forever once a
      // stray duplicate corrupted the parentId chain). The `hover` handler
      // above already refuses to act on a container row
      // (`props.data?.isContainer && !item.data?.isContainer`) precisely so
      // the nested Dustbin stays the sole authority for what lands inside a
      // row/group - the `drop` handler needs the identical guard, not just
      // `didDrop()`, so a container card's own outer wrapper never treats a
      // column drop as "insert me as a new sibling at my row's index" too.
      if (monitor.didDrop()) return undefined;
      if (props.data?.isContainer && !item.data?.isContainer) return undefined;
      const hoverIndex = props.index;
      if (item.data?.parentId && typeof props.insertCard === 'function') {
        props.insertCard(item, hoverIndex, item.id);
        return { destination: 'canvas' };
      }
      if (item.index === -1 && typeof props.insertCard === 'function') {
        const created = typeof item.onCreate === 'function' ? item.onCreate(item.data) : item.data;
        props.insertCard(created, hoverIndex);
        return { destination: 'canvas' };
      }
      return undefined;
    },
    hover: (item, monitor) => {
      // Don't replace items being dragged from box with index -1
      if (item.itemType === ItemTypes.BOX && item.index === -1) return;

      // Don't replace multi-column component unless both drag & hover are multi-column
      if (props.data?.isContainer && !item.data?.isContainer) return;

      // Prevent live-sorting on hover if either element is nested inside a container (parentId is set)
      const dragParentId = item.data?.parentId || item.parentId;
      const hoverParentId = props.data?.parentId;
      
      // If hovering over a nested element, let the Dustbin handle it
      if (hoverParentId) {
        return;
      }

      const dragIndex = item.index;
      const hoverIndex = props.index;

      // Don't replace items with themselves
      if (dragIndex === hoverIndex && !dragParentId) {
        return;
      }

      // A nested card is moved only on drop. Moving it on hover made it leave
      // its group while the pointer was merely crossing an outer container.
      if (dragParentId) return;

      // Palette items are also created only on drop. This avoids a temporary
      // root copy racing a subsequent nested drop.
      if (dragIndex === -1) return;

      // Skip if no ref available
      if (!ref.current) {
        return;
      }

      // Determine rectangle on screen
      const hoverBoundingRect = ref.current.getBoundingClientRect();

      // Get vertical middle
      const hoverMiddleY = (hoverBoundingRect.bottom - hoverBoundingRect.top) / 2;

      // Determine mouse position
      const clientOffset = monitor.getClientOffset();
      if (!clientOffset) return;

      // Get pixels to the top
      const hoverClientY = clientOffset.y - hoverBoundingRect.top;

      // Update hover direction for drop indicator lines
      const newDir = hoverClientY < hoverMiddleY ? 'top' : 'bottom';
      if (hoverDir !== newDir) {
        setHoverDir(newDir);
      }

      // Only perform the move when the mouse has crossed half of the items height
      // When dragging downwards, only move when the cursor is below 50%
      // When dragging upwards, only move when the cursor is above 50%

      // Dragging downwards
      if (dragIndex < hoverIndex && hoverClientY < hoverMiddleY) {
        return;
      }

      // Dragging upwards
      if (dragIndex > hoverIndex && hoverClientY > hoverMiddleY) {
        return;
      }

      // Time to actually perform the action
      if (typeof props.moveCard === 'function') {
        props.moveCard(dragIndex, hoverIndex);
      }

      // Note: we're mutating the monitor item here!
      // Generally it's better to avoid mutations,
      // but it's good here for the sake of performance
      // to avoid expensive index searches.
      item.index = hoverIndex;
    },
  });

  // Clear hoverDir when mouse leaves drop target
  React.useEffect(() => {
    if (!isOver) {
      setHoverDir(null);
    }
  }, [isOver]);

  // Connect the drag and drop refs to the same element
  return {
    ref: (node) => {
      ref.current = node;
      drop(node);
      drag(node);
    },
    previewRef: preview,
    isDragging,
    isOver,
    canDrop,
    hoverDir,
  };
};

// Modern approach using a functional component wrapper instead of HOC
const DraggableCard = (props) => {
  const {
    index,
    id,
    moveCard,
    seq = -1,
    ...restProps
  } = props;

  const { ref, previewRef, isDragging, isOver, canDrop, hoverDir } = useDragAndDrop(props);
  const opacity = isDragging ? 0.35 : 1;

  // Use the ComposedComponent passed in props
  const ComposedComponent = props.component;

  const handleClick = (e) => {
    if (props.data?.custom_metadata?.protectedRoot === true) return;
    // Skip if clicking delete button or drag handle
    const target = e.target;
    if (
      target.classList.contains('fa-trash') || 
      target.classList.contains('btn-danger') || 
      target.closest('.btn-danger') || 
      target.closest('.drag-handle')
    ) {
      return;
    }

    if (props.editModeOn && props.data) {
      props.editModeOn(props.data, e);
    }
  };

  return (
    <div ref={previewRef} style={{ position: 'relative' }}>
      {isOver && canDrop && hoverDir === 'top' && (
        <div className="dnd-insertion-line top" />
      )}
      <div ref={ref} onClick={handleClick}>
        <ComposedComponent 
          {...restProps} 
          index={index}
          id={id}
          moveCard={moveCard}
          seq={seq}
          style={{ ...style, opacity }} 
        />
      </div>
      {isOver && canDrop && hoverDir === 'bottom' && (
        <div className="dnd-insertion-line bottom" />
      )}
    </div>
  );
};

DraggableCard.propTypes = {
  component: PropTypes.elementType.isRequired,
  index: PropTypes.number.isRequired,
  isDragging: PropTypes.bool,
  id: PropTypes.any.isRequired,
  moveCard: PropTypes.func.isRequired,
  seq: PropTypes.number,
};

DraggableCard.defaultProps = {
  seq: -1,
};

// This replaces the HOC pattern with a component that takes the component as a prop
export default function createDraggableCard(ComposedComponent) {
  return (props) => <DraggableCard {...props} component={ComposedComponent} />;
}
