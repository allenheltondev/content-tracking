import { createBrowserRouter } from 'react-router-dom';
import App from './App';
import ProtectedRoute from './auth/ProtectedRoute';
import Home from './routes/Home';
import SignIn from './routes/SignIn';
import SignUp from './routes/SignUp';
import ForgotPassword from './routes/ForgotPassword';
import Campaigns from './routes/Campaigns';
import CampaignDetail from './routes/CampaignDetail';
import CampaignReport from './routes/CampaignReport';
import Vendors from './routes/Vendors';
import VendorDetail from './routes/VendorDetail';
import VendorNew from './routes/VendorNew';
import VendorEdit from './routes/VendorEdit';
import Revenue from './routes/Revenue';
import Settings from './routes/Settings';

export const router = createBrowserRouter([
  {
    path: '/signin',
    element: <SignIn />,
  },
  {
    path: '/signup',
    element: <SignUp />,
  },
  {
    path: '/forgot-password',
    element: <ForgotPassword />,
  },
  {
    // Sponsor-facing print report. Sits outside the App shell so the
    // nav header / sign-out button don't show up in the printed PDF.
    path: '/campaigns/:campaignId/report',
    element: (
      <ProtectedRoute>
        <CampaignReport />
      </ProtectedRoute>
    ),
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
      { path: 'settings', element: <Settings /> },
    ],
  },
]);
