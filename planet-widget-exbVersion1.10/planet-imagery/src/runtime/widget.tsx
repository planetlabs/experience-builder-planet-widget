import { React, type AllWidgetProps } from 'jimu-core'
import {
  loadArcGISJSAPIModules,
  JimuMapViewComponent,
  type JimuMapView
} from 'jimu-arcgis'
import { FeatureLayerZoomToOutlined } from 'jimu-icons/outlined/gis/feature-layer-zoom-to'
import { Button } from 'jimu-ui';
import { getSHConfigExtent, fetchToken } from './utilities';
import * as projection from 'esri/geometry/projection';
import SpatialReference from 'esri/geometry/SpatialReference';


// Components
import DateSelector from './dateSelector';
import LayerSelector from './layerSelector';
import SaveWMTS from './saveWMTS/saveWMTS';


interface State {
  accessToken: string | null;
  availableDates: string[];
  wmtsLayers: __esri.Layer[];
  selectedLayer: string;
  selectedDate: Date;
  // Added an end date to the state
  endDate: Date;
  layerOptions: { title: string; id: string; description: string; collectionId: string }[];
  WMTSError: string;
  configurationExtent: __esri.Extent;
}

interface WidgetConfig {
  configurationID: string;
  collectionID: string;
  credentials: {
    clientID: string;
    clientSecret: string;
  };
  sentinelHubConfiguration: {
    collection_id: string;
    configuration_id: string;
  }
}


export default class Widget extends React.PureComponent<AllWidgetProps<any>, State, WidgetConfig> {
  tokenRefreshInterval: NodeJS.Timeout | null = null;
  WMTSLayer: typeof __esri.WMTSLayer;
  jimuMapView: JimuMapView;
  wmtsLayer: __esri.Layer;

  state: State = {
    accessToken: null,
    availableDates: [],
    wmtsLayers: [],
    selectedLayer: "",
    selectedDate: null,
    // Added an end date to the state
    endDate: null,
    layerOptions: [],
    WMTSError: null,
    configurationExtent: null,
  };


  constructor(props) {
    super(props);
    this.handleDateChange = this.handleDateChange.bind(this);
    // Added a new function to handle the end date change
    this.handleSecondDateChange = this.handleSecondDateChange.bind(this);
    this.handleLayerChange = this.handleLayerChange.bind(this);
  }

  loadModules = async () => {
    [this.WMTSLayer] = await loadArcGISJSAPIModules(['esri/layers/WMTSLayer']);
  };

  async componentDidMount() {
    await this.loadModules();
    await this.fetchAndSetToken();
    this.tokenRefreshInterval = setInterval(() => {
      this.fetchAndSetToken();
    }, 3600000);
  }

  isConfigured = () => {
    return this.props.useMapWidgetIds && this.props.useMapWidgetIds.length === 1
  }

  componentWillUnmount() {
    clearInterval(this.tokenRefreshInterval);
  }

  fetchAndSetToken = async () => {

    const credentials = this.props.config.credentials;

    try {
      const token = await fetchToken(credentials);
      this.setState({ accessToken: token });
      return token; // Return the token for further use
    } catch (error) {
      console.error("Error fetching token:", error);
      return null; // Return null in case of an error
    }
  };

  // Added an end date to the createWmts function
  handleLayerChange = (event) => {

    const newLayer = event.target.value;
    this.setState({ selectedLayer: newLayer });

    if (this.state.selectedDate && newLayer) {
      const isoString = this.state.selectedDate.toISOString().split('T')[0];
      const isoEndString = this.state.endDate.toISOString().split('T')[0];
      this.addWMTSLayer(this.createWmts(isoString, isoEndString, newLayer));
    }

  };

  handleDateChange = (newStartDate) => {
    // If a new start for the date is selected update start date and end date
    if (newStartDate){
      const isoString = newStartDate.toISOString().split('T')[0];
      this.setState({ selectedDate: newStartDate });
      this.setState({ endDate: newStartDate });

      if (this.state.selectedLayer) {
        this.addWMTSLayer(this.createWmts(isoString, isoString, this.state.selectedLayer));
      } else {
        console.log("No valid layer selected.")
      }
    } else {
      console.log("No valid date selected.")
      this.setState({ selectedDate: null });
    }
  };
  
  // Newly added function that creates a new WMTS layer based on the end date
  handleSecondDateChange = (newEndDate) => {

    if (newEndDate && this.state.selectedDate) {
      const isoEndString = newEndDate.toISOString().split('T')[0];
      const isoStartString = this.state.selectedDate.toISOString().split('T')[0];

      this.setState({ endDate: newEndDate });

      if (this.state.selectedLayer) {
        this.addWMTSLayer(this.createWmts(isoStartString, isoEndString, this.state.selectedLayer));
      } else {
        console.log("No valid layer selected.")
      }
    } else {
      console.log("No valid date selected.")
      this.setState({ selectedDate: null });
    }
  };




  // Set the map extent to match the configuration extent
  fetchAndSetConfigurationExtent = async (token) => {
    if (token && this.props.config.sentinelHubConfiguration) {
      try {
        const configurationExtent = await getSHConfigExtent(this.props.config.sentinelHubConfiguration.configuration_id);
        this.setState({ configurationExtent: configurationExtent });

        if (this.jimuMapView && this.jimuMapView.view) {
          this.jimuMapView.view.goTo(configurationExtent);
        }

      } catch (error) {
        console.error('Error fetching extent data:', error);
      }
    } else {
      console.error('Access token or configuration ID is missing');
    }
  };

  // Function to generate WMTS layer based on date
  //changed this to have out date
  createWmts = (startDate: string, endDate: string, inLayer: string): __esri.WMTSLayer => {

    const Layer = inLayer;

    const baseUrl = "https://services.sentinel-hub.com/ogc/wmts";
    const configuration_id = this.props.config.sentinelHubConfiguration.configuration_id;
    const wmtsUrl = `${baseUrl}/${configuration_id}`

    const customParams = {
      // Two dates instead of one
      "TIME": `${startDate}/${endDate}`,
      "LAYER": Layer,
      "transparent": "true"
    };

    const layer = new this.WMTSLayer({
      url: wmtsUrl,
      customLayerParameters: customParams
    });
    return layer;
  };

  addWMTSLayer = (layer: __esri.WMTSLayer) => {

    if (!this.jimuMapView) {
      console.error("Can't add WMTS Layer - Map view is not available");
      return;
    }

    // Remove any previously added WMTS layers
    this.state.wmtsLayers.forEach(layer => {
      this.jimuMapView.view.map.remove(layer);
    });

    // Reset the wmtsLayers array in the state
    this.setState({ wmtsLayers: [] });

    this.jimuMapView.view.map.add(layer, 0);

    // Add the new layer to the wmtsLayers array in the state
    this.setState(state => ({
      wmtsLayers: [...state.wmtsLayers, layer]
    }));
  };


  getMapExtent = async (wkid?: number) => {
    const extent = this.jimuMapView.view.extent;
    console.log('Original Extent:', extent);
  
    if (wkid) {
      const [SpatialReference, projection] = await Promise.all([
        import('esri/geometry/SpatialReference'),
        import('esri/geometry/projection')
      ]);
  
      const outSpatialReference = new SpatialReference.default({ wkid: wkid });
      console.log('Output Spatial Reference:', outSpatialReference);
  

      const projectedExtent = projection.default.project(extent, outSpatialReference);
      console.log('Projected Extent:', projectedExtent);
      return projectedExtent;

    } else {
      return extent;
    }
  }
  

  getEsriCredentials = () => {
    const token = this.props.token;
    const portalUrl = this.props.portalUrl;
    const user = this.props.user;
    const savePermission = this.props.user.privileges.includes("portal:user:createItem")

    return {
      token: token,
      portalUrl: portalUrl,
      user: user,
      savePermission: savePermission
    }
  }

  onActiveViewChange = (jimuMapView: JimuMapView) => {
    if (!jimuMapView) {
      return;
    }
    this.jimuMapView = jimuMapView;
  };

  render() {

    if (!this.isConfigured()) {
      return 'Configure the widget by selecting a map first';
    }

    return (
      <div className="widget-use-map-view" style={{ width: '100%', height: '120%', overflow: 'hidden' }}>

        <JimuMapViewComponent useMapWidgetId={this.props.useMapWidgetIds?.[0]} onActiveViewChange={this.onActiveViewChange}></JimuMapViewComponent>

        
        <div>
          <LayerSelector
            selectedLayer={this.state.selectedLayer}
            accessToken={this.state.accessToken}
            configurationID={this.props.config.sentinelHubConfiguration.configuration_id}
            onLayerChange={this.handleLayerChange}
          />
          <Button
            onClick={() => this.fetchAndSetConfigurationExtent(this.state.accessToken)}
            title="Zoom to Data Extent"
            className="jimu-btn"
          >
            <FeatureLayerZoomToOutlined size='m' />
          </Button>
        </div>
        <br />
        <div>
          <DateSelector
            selectedDate={this.state.selectedDate}
            // Allows to select two dates 
            endDate={this.state.endDate}
            accessToken={this.state.accessToken}
            handleDateChange={this.handleDateChange}
            //Handle second date change function
            handleSecondDateChange={this.handleSecondDateChange}
            collectionID={this.props.config.sentinelHubConfiguration.collection_id}
            getMapExtent={this.getMapExtent}
          />
        </div>
        {this.getEsriCredentials().savePermission && (
          <div>
            <SaveWMTS
              selectedDate={this.state.selectedDate}
              selectedLayer={this.state.selectedLayer}
              getMapExtent={this.getMapExtent}
              configurationID={this.props.config.sentinelHubConfiguration.configuration_id}
              wmtsLayers={this.state.wmtsLayers}
              getEsriCredentials={this.getEsriCredentials}
            />
          </div>
        )}
      </div>
    )
  }
}