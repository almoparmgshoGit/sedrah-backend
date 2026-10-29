import { Router } from 'express';
import { getCompanies, getCompanyById, getCompanyPackages, getCompanyReviews, addCompanyReview, getMyCompanyProfile } from '../controllers/companies.controller';
import { authenticate } from '../middlewares/security.middleware';

const router = Router();

router.get('/', getCompanies);
router.get('/my-profile', authenticate, getMyCompanyProfile);
router.get('/:id', getCompanyById);
router.get('/:id/packages', getCompanyPackages);
router.get('/:id/reviews', getCompanyReviews);
router.post('/:id/reviews', authenticate, addCompanyReview);

export default router;
