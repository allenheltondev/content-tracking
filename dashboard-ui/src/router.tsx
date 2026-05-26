import { createBrowserRouter } from 'react-router-dom';
import App from './App';
import AuthCallback from './auth/AuthCallback';
import ProtectedRoute from './auth/ProtectedRoute';
import Home from './routes/Home';
import Campaigns from './routes/Campaigns';
import CampaignDetail from './routes/CampaignDetail';
import Vendors from './routes/Vendors';
import VendorDetail from './routes/VendorDetail';
import VendorNew from './routes/VendorNew';
import VendorEdit from './routes/VendorEdit';
import Revenue from './routes/Revenue';
import BriefNew from './routes/BriefNew';
import BriefDetail from './routes/BriefDetail';

export const router = createBrowserRouter([
  {
    path: '/auth/callback',
    element: <AuthCallback />,
  },
  {
    path: '/',
    element: (
      <ProtectedRoute>
        <App />
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: <Home /> },
      { path: 'campaigns', element: <Campaigns /> },
      { path: 'campaigns/:campaignId', element: <CampaignDetail /> },
      { path: 'vendors', element: <Vendors /> },
      { path: 'vendors/new', element: <VendorNew /> },
      { path: 'vendors/:vendorId', element: <VendorDetail /> },
      { path: 'vendors/:vendorId/edit', element: <VendorEdit /> },
      { path: 'revenue', element: <Revenue /> },
      { path: 'briefs/new', element: <BriefNew /> },
      { path: 'briefs/:briefId', element: <BriefDetail /> },
    ],
  },
]);
