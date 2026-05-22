import { createBrowserRouter } from 'react-router-dom';
import App from './App';
import Home from './routes/Home';
import Campaigns from './routes/Campaigns';
import CampaignDetail from './routes/CampaignDetail';
import Vendors from './routes/Vendors';
import VendorDetail from './routes/VendorDetail';
import Revenue from './routes/Revenue';
import BriefNew from './routes/BriefNew';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Home /> },
      { path: 'campaigns', element: <Campaigns /> },
      { path: 'campaigns/:campaignId', element: <CampaignDetail /> },
      { path: 'vendors', element: <Vendors /> },
      { path: 'vendors/:vendorId', element: <VendorDetail /> },
      { path: 'revenue', element: <Revenue /> },
      { path: 'briefs/new', element: <BriefNew /> },
    ],
  },
]);
