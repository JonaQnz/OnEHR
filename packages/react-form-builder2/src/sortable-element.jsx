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
    drop: (item) => {
      if (item.index === -1) {
        const hoverIndex = props.index;
        if (typeof props.insertCard === 'function') {
          props.insertCard(item, hoverIndex, item.id);
        }
      }
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

      // If pulling an item out of a layout to the root canvas:
      if (dragParentId) {
        if (typeof props.insertCard === 'function') {
           props.insertCard(item, hoverIndex, item.id);
           item.parentId = undefined;
           if (item.data) item.data.parentId = undefined;
           item.index = hoverIndex;
        }
        return;
      }

      // Handle new items being created
      if (dragIndex === -1) {
        if (props.data && props.data.isContainer) {
          return;
        }
        
        if (typeof props.insertCard !== 'function') {
          return;
        }

        item.index = hoverIndex;
        props.insertCard(item.onCreate(item.data), hoverIndex);
        return;
      }

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