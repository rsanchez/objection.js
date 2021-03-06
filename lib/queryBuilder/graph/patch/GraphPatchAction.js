'use strict';

const { GraphAction } = require('../GraphAction');
const { isInternalProp } = require('../../../utils/internalPropUtils');
const { union, difference, isObject } = require('../../../utils/objectUtils');
const promiseUtils = require('../../../utils/promiseUtils');

class GraphPatchAction extends GraphAction {
  constructor({ nodes, graph, currentGraph, graphOptions }) {
    super();

    // Nodes to patch.
    this.nodes = nodes;
    this.graph = graph;
    this.currentGraph = currentGraph;
    this.graphOptions = graphOptions;
  }

  run(builder) {
    return promiseUtils.map(this.nodes, node => this._runForNode(builder, node), {
      concurrency: this._getConcurrency(builder, this.nodes)
    });
  }

  _runForNode(builder, node) {
    const shouldPatch = this.graphOptions.shouldPatch(node, this.currentGraph);
    const shouldUpdate = this.graphOptions.shouldUpdate(node, this.currentGraph);

    // BelongsToOneRelation inserts and relates change the parent object's
    // properties. That's why we handle them here.
    const changedPropsBecauseOfBelongsToOneInsert = this._handleBelongsToOneInserts(node);

    // BelongsToOneRelation deletes and unrelates change the parent object's
    // properties. That's why we handle them here.
    const changePropsBecauseOfBelongsToOneDelete = this._handleBelongsToOneDeletes(node);

    const { changedProps, unchangedProps } = this._findChanges(node);
    const allProps = union(changedProps, unchangedProps);

    const propsToUpdate = difference(
      shouldPatch || shouldUpdate
        ? changedProps
        : [...changedPropsBecauseOfBelongsToOneInsert, ...changePropsBecauseOfBelongsToOneDelete],

      // Remove id properties from the props to update. With upsertGraph
      // it never makes sense to change the id.
      node.modelClass.getIdPropertyArray()
    );

    if (propsToUpdate.length === 0) {
      return null;
    }

    delete node.obj[node.modelClass.uidRefProp];
    delete node.obj[node.modelClass.dbRefProp];

    node.obj.$validate(null, {
      dataPath: node.dataPathKey,
      patch: shouldPatch || (!shouldPatch && !shouldUpdate)
    });

    // Don't update the fields that we know not to change.
    node.obj.$omitFromDatabaseJson(difference(allProps, propsToUpdate));
    node.userData.updated = true;

    const updateBuilder = this._createBuilder(node)
      .childQueryOf(builder)
      .copyFrom(builder, GraphAction.ReturningAllSelector);

    if (shouldPatch) {
      updateBuilder.patch(node.obj);
    } else {
      updateBuilder.update(node.obj);
    }

    return updateBuilder.execute().then(result => {
      if (isObject(result) && result.$isObjectionModel) {
        // Handle returning('*').
        node.obj.$set(result);
      }

      return result;
    });
  }

  _handleBelongsToOneInserts(node) {
    const currentNode = this.currentGraph.nodeForNode(node);
    const updatedProps = [];

    for (const edge of node.edges) {
      if (
        edge.isOwnerNode(node) &&
        edge.relation &&
        edge.relation.isObjectionBelongsToOneRelation &&
        edge.relation.relatedProp.hasProps(edge.relatedNode.obj)
      ) {
        const { relation } = edge;

        for (let i = 0, l = relation.ownerProp.size; i < l; ++i) {
          const currentValue = currentNode && relation.ownerProp.getProp(currentNode.obj, i);
          const relatedValue = relation.relatedProp.getProp(edge.relatedNode.obj, i);

          if (currentValue != relatedValue) {
            relation.ownerProp.setProp(node.obj, i, relatedValue);
            updatedProps.push(relation.ownerProp.props[i]);
          }
        }
      }
    }

    return updatedProps;
  }

  _handleBelongsToOneDeletes(node) {
    const currentNode = this.currentGraph.nodeForNode(node);
    const updatedProps = [];

    if (!currentNode) {
      return updatedProps;
    }

    for (const edge of currentNode.edges) {
      if (
        edge.isOwnerNode(currentNode) &&
        edge.relation.isObjectionBelongsToOneRelation &&
        node.obj[edge.relation.name] === null &&
        this.graphOptions.shouldDeleteOrUnrelate(edge.relatedNode, this.graph)
      ) {
        const { relation } = edge;

        for (let i = 0, l = relation.ownerProp.size; i < l; ++i) {
          const currentValue = relation.ownerProp.getProp(currentNode.obj, i);

          if (currentValue != null) {
            relation.ownerProp.setProp(node.obj, i, null);
            updatedProps.push(relation.ownerProp.props[i]);
          }
        }
      }
    }

    return updatedProps;
  }

  _findChanges(node) {
    const obj = node.obj;
    const currentNode = this.currentGraph.nodeForNode(node);
    const currentObj = (currentNode && currentNode.obj) || {};
    const relationNames = node.modelClass.getRelationNames();

    const unchangedProps = [];
    const changedProps = [];

    for (const prop of Object.keys(obj)) {
      if (isInternalProp(prop) || relationNames.includes(prop)) {
        continue;
      }

      const value = obj[prop];
      const currentValue = currentObj[prop];

      // If the current object doesn't have the property, we have to assume
      // it changes (we cannot know if it will). If the object does have the
      // property, we test non-strict equality. See issue #732.
      if (currentValue === undefined || currentValue != value) {
        changedProps.push(prop);
      } else {
        unchangedProps.push(prop);
      }
    }

    // We cannot know if the query properties cause changes to the values.
    // We must assume that they do.
    if (obj.$$queryProps) {
      changedProps.push(...Object.keys(obj.$$queryProps));
    }

    return {
      changedProps,
      unchangedProps
    };
  }

  _createBuilder(node) {
    const currentNode = this.currentGraph.nodeForNode(node);

    if (currentNode && currentNode.parentEdge) {
      return this._createRelatedBuilder(node);
    } else {
      return this._createRootBuilder(node);
    }
  }

  _createRelatedBuilder(node) {
    return node.parentNode.obj
      .$relatedQuery(node.parentEdge.relation.name)
      .findById(node.obj.$id());
  }

  _createRootBuilder(node) {
    return node.obj.$query();
  }
}

module.exports = {
  GraphPatchAction
};
