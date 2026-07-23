/**
  * <ReactFormBuilder />
*/

import React from 'react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { IntlProvider } from 'react-intl';
import Preview from './preview';
import Toolbar from './toolbar';
import FormGenerator from './form';
import store from './stores/store';
import Registry from './stores/registry';
import AppLocale from './language-provider';
import FormElementsEdit from './form-dynamic-edit';

class ReactFormBuilder extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      editMode: false,
      editElement: null,
    };
    this.editModeOn = this.editModeOn.bind(this);
  }

  editModeOn(data, e) {
    e.preventDefault();
    e.stopPropagation();
    if (this.state.editMode && this.state.editElement && this.state.editElement.id === data.id) {
      this.setState({ editMode: false, editElement: null });
    } else {
      this.setState({ editMode: true, editElement: data });
    }
  }

  manualEditModeOff() {
    if (this.state.editMode) {
      this.setState({
        editMode: false,
        editElement: null,
      });
    }
  }

  render() {
    const toolbarProps = {
      showDescription: this.props.show_description,
    };

    const language = this.props.locale ? this.props.locale : 'en';
    const currentAppLocale = AppLocale[language];
    if (this.props.toolbarItems) { toolbarProps.items = this.props.toolbarItems; }
    const content = (
      <IntlProvider
        locale={currentAppLocale.locale}
        messages={currentAppLocale.messages}>
        <div>
          {/* <div>
         <p>
           It is easy to implement a sortable interface with React DnD. Just make
           the same component both a drag source and a drop target, and reorder
           the data in the <code>hover</code> handler.
         </p>
         <Container />
       </div> */}
          <div className="react-form-builder clearfix">
            <div>
              <Preview
                files={this.props.files}
                manualEditModeOff={this.manualEditModeOff.bind(this)}
                showCorrectColumn={this.props.showCorrectColumn}
                parent={this}
                data={this.props.data}
                url={this.props.url}
                saveUrl={this.props.saveUrl}
                onLoad={this.props.onLoad}
                onPost={this.props.onPost}
                editModeOn={this.editModeOn}
                editMode={this.state.editMode}
                variables={this.props.variables}
                registry={Registry}
                editElement={this.state.editElement}
                renderEditForm={this.props.renderEditForm}
                saveAlways={this.props.saveAlways}
              />
              {!this.props.hideToolbar && <Toolbar {...toolbarProps} customItems={this.props.customToolbarItems} />}
            </div>
          </div>
        </div>
      </IntlProvider>
    );

    if (this.props.wrapDnd === false) {
      return content;
    }

    return (
      <DndProvider backend={HTML5Backend} context={window}>
        {content}
      </DndProvider>
    );
  }
}

function ReactFormGenerator(props) {
  const language = props.locale ? props.locale : 'en';
  const currentAppLocale = AppLocale[language];
  return (
    <IntlProvider
      locale={currentAppLocale.locale}
      messages={currentAppLocale.messages}>
      <FormGenerator {...props} />
    </IntlProvider>
  );
}

const FormBuilders = {};
FormBuilders.ReactFormBuilder = ReactFormBuilder;
FormBuilders.ReactFormGenerator = ReactFormGenerator;
FormBuilders.ElementStore = store;
FormBuilders.Registry = Registry;
FormBuilders.FormElementsEdit = FormElementsEdit;
FormBuilders.AppLocale = AppLocale;

export default FormBuilders;

export {
  ReactFormBuilder, ReactFormGenerator, store as ElementStore, Registry, FormElementsEdit, AppLocale,
};
