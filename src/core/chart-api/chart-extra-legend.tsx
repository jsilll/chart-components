// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type Highcharts from "highcharts";

import { LegendItem } from "../../internal/components/interfaces";
import { ChartSeriesMarker, ChartSeriesMarkerType } from "../../internal/components/series-marker";
import { ChartSeriesMarkerStatus } from "../../internal/components/series-marker/interfaces";
import { fireNonCancelableEvent } from "../../internal/events";
import AsyncStore from "../../internal/utils/async-store";
import { getChartSeries, getMasterSeries } from "../../internal/utils/chart-series";
import { isEqualArrays } from "../../internal/utils/utils";
import { CoreChartProps } from "../interfaces";
import { getChartLegendItems, getOptionsId, getPointId, getSeriesId, getVisibleLegendItems } from "../utils";
import { ChartExtraContext } from "./chart-extra-context";

// Derives legend items from raw Highcharts options (no chart instance needed).
// Used to seed the legend store before Highcharts renders, so the legend occupies its
// real height on the first paint and the chart height calculation is correct.
export function getInitialLegendItems(
  options: CoreChartProps.ChartOptions,
  colors: string[],
  getItemOptions: CoreChartProps.GetItemOptions = () => ({}),
): readonly CoreChartProps.LegendItem[] {
  const { primaryItems, secondaryItems } = getVisibleLegendItems(options);
  const allItems = [
    ...primaryItems.map((item) => ({ item, isSecondary: false })),
    ...secondaryItems.map((item) => ({ item, isSecondary: true })),
  ];
  return allItems.map(({ item, isSecondary }, index) => {
    const id = getOptionsId(item as { id?: string; name?: string });
    const name = (item as { name?: string }).name ?? "";
    const color = (item as { color?: string }).color ?? colors[index % colors.length] ?? "black";
    const status = getItemOptions(id).status;
    const markerType: ChartSeriesMarkerType = getSeriesMarkerTypeFromOptions(item);
    const marker = <ChartSeriesMarker type={markerType} color={color} visible={true} status={status} />;
    return { id, name, marker, visible: true, highlighted: false, isSecondary };
  });
}

function getSeriesMarkerTypeFromOptions(
  item: Highcharts.SeriesOptionsType | Highcharts.PointOptionsType,
): ChartSeriesMarkerType {
  if (!item || typeof item !== "object") {
    return "large-square";
  }
  if (!("type" in item)) {
    return "large-square";
  }
  if ("dashStyle" in item && item.dashStyle && item.dashStyle !== "Solid") {
    return "dashed";
  }
  switch (item.type) {
    case "area":
    case "areaspline":
      return "hollow-square";
    case "line":
    case "spline":
      return "line";
    case "column":
    case "pie":
      return "large-square";
    case "bubble":
      return "circle";
    default:
      return "large-square";
  }
}

// The reactive state is used to propagate changes in legend items to the core legend React component.
export interface ReactiveLegendState {
  items: readonly CoreChartProps.LegendItem[];
}

// Chart helper that implements custom legend behaviors.
export class ChartExtraLegend extends AsyncStore<ReactiveLegendState> {
  private context: ChartExtraContext;
  private visibilityMode: "internal" | "external" = "external";

  constructor(context: ChartExtraContext, initialItems: readonly CoreChartProps.LegendItem[] = []) {
    super({ items: initialItems });
    this.context = context;
  }

  public onChartRender = () => {
    this.initLegend();
    this.updateItemsVisibility();
  };

  // Update the legend store with items derived from props before Highcharts renders.
  // Only used before the chart is ready (i.e. before the first onChartRender).
  public seedItems = (items: readonly CoreChartProps.LegendItem[]) => {
    const prevState = this.get().items.reduce(
      (map, item) => map.set(item.id, item),
      new Map<string, CoreChartProps.LegendItem>(),
    );
    const merged = items.map((item) => ({ ...item, highlighted: prevState.get(item.id)?.highlighted ?? false }));
    this.updateLegendItems(merged);
  };

  // If visible items are explicitly provided, we use them to update visibility of chart's series or points (by ID).
  // If not provided, the visibility state is managed internally.
  public updateItemsVisibility = () => {
    if (this.context.state.visibleItems) {
      this.visibilityMode = "external";
      updateItemsVisibility(this.context.chart(), this.get().items, this.context.state.visibleItems);
    } else {
      this.visibilityMode = "internal";
    }
  };

  // A callback to be called when items visibility changes from the outside or from the legend.
  public onItemVisibilityChange = (visibleItems: readonly string[], detail: CoreChartProps.InteractionKind) => {
    const currentItems = this.get().items;
    const updatedItems = currentItems.map((i) => ({ ...i, visible: visibleItems.includes(i.id) }));
    if (this.visibilityMode === "internal") {
      this.updateLegendItems(updatedItems);
      updateItemsVisibility(this.context.chart(), this.get().items, visibleItems);
    }
    fireNonCancelableEvent(this.context.handlers.onVisibleItemsChange, { items: updatedItems, ...detail });
  };

  // Updates legend highlight state when chart's point is highlighted.
  public onHighlightPoint = (point: Highcharts.Point) => {
    const masterSeries = getMasterSeries(point);
    const visibleItems = point.series.type === "pie" ? [getPointId(point)] : [getSeriesId(masterSeries)];
    this.onHighlightItems(visibleItems);
  };

  // Updates legend highlight state when chart's group of points is highlighted.
  public onHighlightGroup = (group: readonly Highcharts.Point[]) => {
    const visibleItems = group.map((point) => getSeriesId(getMasterSeries(point)));
    this.onHighlightItems(visibleItems);
  };

  // Updates legend highlight state given an explicit list of item IDs. This is used to update state
  // when a legend item gets hovered or focused.
  public onHighlightItems = (highlightedItems: readonly string[]) => {
    const currentItems = this.get().items;
    const updatedItems = currentItems.map(({ ...i }) => ({ ...i, highlighted: highlightedItems.includes(i.id) }));
    this.updateLegendItems(updatedItems);
  };

  // Clears legend highlight state.
  public onClearHighlight = () => {
    const nextItems = this.get().items.map(({ ...item }) => ({ ...item, highlighted: false }));
    this.updateLegendItems(nextItems);
  };

  private initLegend = () => {
    const prevState = this.get().items.reduce((map, item) => map.set(item.id, item), new Map<string, LegendItem>());
    const itemSpecs = getChartLegendItems({
      chart: this.context.chart(),
      getItemOptions: this.context.settings.getItemOptions,
      itemMarkerStatusAriaLabel: this.context.settings.labels.itemMarkerLabel,
    });
    const legendItems = itemSpecs.map(
      ({ id, name, color, markerType, visible, status, isSecondary, markerAriaLabel }) => {
        const marker = this.renderMarker({ type: markerType, color, visible, status, ariaLabel: markerAriaLabel });
        return { id, name, marker, visible, isSecondary, highlighted: prevState.get(id)?.highlighted ?? false };
      },
    );
    this.updateLegendItems(legendItems);
  };

  private updateLegendItems = (nextItems: CoreChartProps.LegendItem[]) => {
    function isLegendItemsEqual(a: CoreChartProps.LegendItem, b: CoreChartProps.LegendItem) {
      return (
        a.id === b.id &&
        a.name === b.name &&
        a.marker === b.marker &&
        a.visible === b.visible &&
        a.highlighted === b.highlighted
      );
    }
    if (!isEqualArrays(this.get().items, nextItems, isLegendItemsEqual)) {
      this.set(() => ({ items: nextItems }));
    }
  };

  // The chart markers derive from type and color and are cached to avoid unnecessary renders,
  // and allow comparing them by reference.
  private markersCache = new Map<string, React.ReactNode>();
  public renderMarker({
    type,
    status = "default",
    color,
    visible = true,
    ariaLabel,
  }: {
    type: ChartSeriesMarkerType;
    color: string;
    visible?: boolean;
    status?: ChartSeriesMarkerStatus;
    ariaLabel?: string;
  }): React.ReactNode {
    const key = `${type}:${color}:${visible}:${status}`;
    const marker = this.markersCache.get(key) ?? (
      <ChartSeriesMarker type={type} color={color} visible={visible} status={status} ariaLabel={ariaLabel} />
    );
    this.markersCache.set(key, marker);
    return marker;
  }
}

function updateItemsVisibility(
  chart: Highcharts.Chart,
  legendItems: readonly CoreChartProps.LegendItem[],
  visibleItems?: readonly string[],
) {
  const availableItemsSet = new Set(legendItems.map((i) => i.id));
  const visibleItemsSet = new Set(visibleItems);

  let updatesCounter = 0;
  const getVisibleAndCount = (id: string, visible: boolean) => {
    const nextVisible = visibleItemsSet.has(id);
    updatesCounter += nextVisible !== visible ? 1 : 0;
    return nextVisible;
  };

  for (const series of getChartSeries(chart.series)) {
    if (availableItemsSet.has(getSeriesId(series))) {
      series.setVisible(getVisibleAndCount(getSeriesId(series), series.visible), false);
    }
    for (const point of series.data) {
      if (typeof point.setVisible === "function" && availableItemsSet.has(getPointId(point))) {
        point.setVisible(getVisibleAndCount(getPointId(point), point.visible), false);
      }
    }
  }

  // The call `seriesOrPoint.setVisible(visible, false)` does not trigger the chart redraw, as it would otherwise
  // impact the performance. Instead, we trigger the redraw explicitly, if any change to visibility has been made.
  if (updatesCounter > 0) {
    chart.redraw();
  }
}
