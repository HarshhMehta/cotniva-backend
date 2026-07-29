require('dotenv').config();

const connectDB = require('./config/db');
const Products = require('./model/Products');
const Category = require('./model/Category');
const Brand = require('./model/Brand');

// Use i.ibb.co (already allowed in admin/front Next.js image config).
// Unsplash needs images.unsplash.com in next.config + redeploy to work on Vercel.
const imgs = {
  kurti1: 'https://i.ibb.co/gg9yCwX/clothing-1.png',
  kurti2: 'https://i.ibb.co/tZFbTWQ/clothing-2.png',
  kurti3: 'https://i.ibb.co/1JqwRnb/clothing-3.png',
  kurti4: 'https://i.ibb.co/ngwgSt2/clothing-4.png',
  dress1: 'https://i.ibb.co/xXHLYZr/clothing-5.png',
  dress2: 'https://i.ibb.co/JqDrC9g/clothing-6.png',
  dress3: 'https://i.ibb.co/3cFJrkR/clothing-7.png',
  top1: 'https://i.ibb.co/yf4LB8p/clothing-8.png',
  top2: 'https://i.ibb.co/DKJr0w4/clothing-9.png',
  top3: 'https://i.ibb.co/SP3Q7b6/clothing-10.png',
  ethnic1: 'https://i.ibb.co/DV3T9Cq/clothing-11.png',
  ethnic2: 'https://i.ibb.co/P9qdSXC/clothing-12.png',
  fashion1: 'https://i.ibb.co/ThxGY6N/clothing-13.png',
  fashion2: 'https://i.ibb.co/dJfjNcJ/clothing-14.png',
  fashion3: 'https://i.ibb.co/2Yf7bqs/clothing-15.png',
  fashion4: 'https://i.ibb.co/zf49GS3/clothing-16.png',
  fashion5: 'https://i.ibb.co/gg9yCwX/clothing-1.png',
  fashion6: 'https://i.ibb.co/tZFbTWQ/clothing-2.png',
};

/**
 * Products are mapped to whatever categories exist in the DB.
 * Keys below are matched loosely against category.parent names.
 */
const dummyCatalog = [
  {
    sku: 'DUM-SSK-001',
    title: 'Floral Strap Short Kurti',
    unit: '1pcs',
    imageURLs: [
      { img: imgs.kurti1, isDefault: true },
      { img: imgs.dress1, isDefault: false },
    ],
    categoryMatch: 'strap short',
    price: 899,
    discount: 10,
    quantity: 40,
    sizes: ['S', 'M', 'L', 'XL'],
    description:
      'Lightweight floral strap short kurti with a breezy fit — perfect for everyday ethnic wear.',
    tags: ['kurti', 'strap', 'dummy'],
    featured: true,
    newArrival: true,
  },
  {
    sku: 'DUM-SSK-002',
    title: 'Cotton Strap Top Kurti',
    unit: '1pcs',
    imageURLs: [
      { img: imgs.kurti2, isDefault: true },
      { img: imgs.top1, isDefault: false },
    ],
    categoryMatch: 'strap short',
    price: 749,
    discount: 5,
    quantity: 55,
    sizes: ['S', 'M', 'L'],
    description:
      'Soft cotton strap short kurti designed for all-day comfort with a clean minimal look.',
    tags: ['kurti', 'cotton', 'dummy'],
    bestSeller: true,
  },
  {
    sku: 'DUM-SSK-003',
    title: 'Pastel Strap Short Kurti',
    unit: '1pcs',
    imageURLs: [
      { img: imgs.dress2, isDefault: true },
      { img: imgs.fashion1, isDefault: false },
    ],
    categoryMatch: 'strap short',
    price: 999,
    discount: 15,
    quantity: 32,
    sizes: ['M', 'L', 'XL'],
    description:
      'Pastel-tone strap short kurti with soft draping — ideal for brunch and casual outings.',
    tags: ['kurti', 'pastel', 'dummy'],
    newArrival: true,
  },
  {
    sku: 'DUM-CK-004',
    title: 'Classic Corset Kurti',
    unit: '1pcs',
    imageURLs: [
      { img: imgs.kurti3, isDefault: true },
      { img: imgs.fashion2, isDefault: false },
    ],
    categoryMatch: 'corset',
    price: 1299,
    discount: 12,
    quantity: 28,
    sizes: ['S', 'M', 'L', 'XL'],
    description:
      'Structured corset kurti with a flattering silhouette and premium fabric finish.',
    tags: ['corset', 'kurti', 'dummy'],
    featured: true,
  },
  {
    sku: 'DUM-CK-005',
    title: 'Embroidered Corset Kurti',
    unit: '1pcs',
    imageURLs: [
      { img: imgs.ethnic1, isDefault: true },
      { img: imgs.kurti4, isDefault: false },
    ],
    categoryMatch: 'corset',
    price: 1499,
    discount: 8,
    quantity: 22,
    sizes: ['S', 'M', 'L'],
    description:
      'Elegant embroidered corset kurti that blends traditional detailing with a modern fit.',
    tags: ['corset', 'embroidered', 'dummy'],
    bestSeller: true,
  },
  {
    sku: 'DUM-CK-006',
    title: 'Black Evening Corset Kurti',
    unit: '1pcs',
    imageURLs: [
      { img: imgs.fashion3, isDefault: true },
      { img: imgs.dress3, isDefault: false },
    ],
    categoryMatch: 'corset',
    price: 1599,
    discount: 10,
    quantity: 18,
    sizes: ['M', 'L', 'XL'],
    description:
      'Bold black corset kurti for evening looks — structured waist and soft flowing hem.',
    tags: ['corset', 'evening', 'dummy'],
    featured: true,
    newArrival: true,
  },
  {
    sku: 'DUM-TSK-007',
    title: 'Boho Tie-Strap Kurti',
    unit: '1pcs',
    imageURLs: [
      { img: imgs.ethnic2, isDefault: true },
      { img: imgs.fashion4, isDefault: false },
    ],
    categoryMatch: 'tie-strap',
    price: 1099,
    discount: 10,
    quantity: 35,
    sizes: ['S', 'M', 'L', 'XL'],
    description:
      'Boho-inspired tie-strap kurti with adjustable straps and a relaxed festive vibe.',
    tags: ['tie-strap', 'kurti', 'dummy'],
    newArrival: true,
  },
  {
    sku: 'DUM-TSK-008',
    title: 'Printed Tie-Strap Kurti',
    unit: '1pcs',
    imageURLs: [
      { img: imgs.fashion5, isDefault: true },
      { img: imgs.top2, isDefault: false },
    ],
    categoryMatch: 'tie-strap',
    price: 949,
    discount: 7,
    quantity: 44,
    sizes: ['S', 'M', 'L'],
    description:
      'Vibrant printed tie-strap kurti that is easy to style for casual days and festive evenings.',
    tags: ['tie-strap', 'printed', 'dummy'],
    bestSeller: true,
  },
  {
    sku: 'DUM-TSK-009',
    title: 'Linen Tie-Strap Kurti',
    unit: '1pcs',
    imageURLs: [
      { img: imgs.fashion6, isDefault: true },
      { img: imgs.dress1, isDefault: false },
    ],
    categoryMatch: 'tie-strap',
    price: 1199,
    discount: 5,
    quantity: 30,
    sizes: ['M', 'L', 'XL'],
    description:
      'Breathable linen tie-strap kurti with a soft fall — made for warm-weather comfort.',
    tags: ['tie-strap', 'linen', 'dummy'],
    featured: true,
  },
  {
    sku: 'DUM-CT-010',
    title: 'Ribbed Everyday Crop Top',
    unit: '1pcs',
    imageURLs: [
      { img: imgs.top1, isDefault: true },
      { img: imgs.top3, isDefault: false },
    ],
    categoryMatch: 'crop top',
    price: 499,
    discount: 0,
    quantity: 70,
    sizes: ['XS', 'S', 'M', 'L'],
    description:
      'Soft ribbed crop top for everyday layering — stretchy, comfy, and easy to pair.',
    tags: ['crop-top', 'casual', 'dummy'],
    bestSeller: true,
  },
  {
    sku: 'DUM-CT-011',
    title: 'Square Neck Crop Top',
    unit: '1pcs',
    imageURLs: [
      { img: imgs.top2, isDefault: true },
      { img: imgs.fashion1, isDefault: false },
    ],
    categoryMatch: 'crop top',
    price: 599,
    discount: 10,
    quantity: 50,
    sizes: ['S', 'M', 'L'],
    description:
      'Trendy square-neck crop top with a flattering cut for jeans, skirts, or co-ord sets.',
    tags: ['crop-top', 'square-neck', 'dummy'],
    newArrival: true,
  },
  {
    sku: 'DUM-CT-012',
    title: 'Satin Party Crop Top',
    unit: '1pcs',
    imageURLs: [
      { img: imgs.top3, isDefault: true },
      { img: imgs.fashion2, isDefault: false },
    ],
    categoryMatch: 'crop top',
    price: 799,
    discount: 15,
    quantity: 26,
    sizes: ['S', 'M', 'L', 'XL'],
    description:
      'Shiny satin crop top made for parties and nights out — pair with high-waist bottoms.',
    tags: ['crop-top', 'party', 'dummy'],
    featured: true,
  },
  {
    sku: 'DUM-SSK-013',
    title: 'Summer Breeze Strap Kurti',
    unit: '1pcs',
    imageURLs: [
      { img: imgs.dress3, isDefault: true },
      { img: imgs.kurti1, isDefault: false },
    ],
    categoryMatch: 'strap short',
    price: 849,
    discount: 8,
    quantity: 38,
    sizes: ['S', 'M', 'L', 'XL'],
    description:
      'Airy summer strap short kurti with soft fabric and an easy everyday silhouette.',
    tags: ['kurti', 'summer', 'dummy'],
  },
  {
    sku: 'DUM-CK-014',
    title: 'Festive Red Corset Kurti',
    unit: '1pcs',
    imageURLs: [
      { img: imgs.kurti4, isDefault: true },
      { img: imgs.ethnic1, isDefault: false },
    ],
    categoryMatch: 'corset',
    price: 1699,
    discount: 12,
    quantity: 20,
    sizes: ['S', 'M', 'L'],
    description:
      'Festive red corset kurti with rich color and a structured bodice for celebrations.',
    tags: ['corset', 'festive', 'dummy'],
    featured: true,
    bestSeller: true,
  },
  {
    sku: 'DUM-CT-015',
    title: 'Knit Comfort Crop Top',
    unit: '1pcs',
    imageURLs: [
      { img: imgs.fashion1, isDefault: true },
      { img: imgs.top1, isDefault: false },
    ],
    categoryMatch: 'crop top',
    price: 549,
    discount: 5,
    quantity: 60,
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    description:
      'Soft knit crop top with stretch comfort — a wardrobe staple for casual days.',
    tags: ['crop-top', 'knit', 'dummy'],
    newArrival: true,
  },
];

const slugify = (title) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const findCategory = (categories, match) => {
  const needle = match.toLowerCase();
  return categories.find((c) => c.parent.toLowerCase().includes(needle));
};

const seedDummyProducts = async () => {
  try {
    await connectDB();

    const categories = await Category.find({});
    const brands = await Brand.find({});

    if (!categories.length) {
      console.error('No categories found. Add categories in admin first.');
      process.exit(1);
    }

    console.log(
      'Using categories:',
      categories.map((c) => c.parent).join(', ')
    );

    const brand = brands[0] || null;

    const existingSkus = new Set(
      (
        await Products.find({
          sku: { $in: dummyCatalog.map((p) => p.sku) },
        }).select('sku')
      ).map((p) => p.sku)
    );

    const toInsert = [];

    for (const item of dummyCatalog) {
      if (existingSkus.has(item.sku)) {
        console.log(`Skipping existing SKU: ${item.sku}`);
        continue;
      }

      const category = findCategory(categories, item.categoryMatch);
      if (!category) {
        console.warn(
          `No category matching "${item.categoryMatch}" for ${item.sku}, skipping`
        );
        continue;
      }

      const child =
        Array.isArray(category.children) && category.children.length
          ? category.children[0]
          : '';

      toInsert.push({
        sku: item.sku,
        title: item.title,
        slug: slugify(item.title),
        unit: item.unit,
        imageURLs: item.imageURLs,
        sizes: item.sizes || [],
        parent: category.parent,
        children: child,
        price: item.price,
        discount: item.discount || 0,
        quantity: item.quantity,
        brand: brand
          ? { name: brand.name, id: brand._id }
          : { name: '', id: null },
        category: {
          name: category.parent,
          id: category._id,
        },
        status: 'in-stock',
        productType: category.productType || 'fashion',
        description: item.description,
        additionalInformation: [
          { key: 'Source', value: 'Dummy Unsplash product' },
          { key: 'SKU', value: item.sku },
        ],
        tags: item.tags || [],
        featured: !!item.featured,
        newArrival: !!item.newArrival,
        bestSeller: !!item.bestSeller,
        sellCount: Math.floor(Math.random() * 40),
      });
    }

    if (!toInsert.length) {
      console.log('No new dummy products to insert.');
      process.exit(0);
    }

    const inserted = await Products.insertMany(toInsert);

    for (const product of inserted) {
      await Category.updateOne(
        { _id: product.category.id },
        { $addToSet: { products: product._id } }
      );
      if (product.brand?.id) {
        await Brand.updateOne(
          { _id: product.brand.id },
          { $addToSet: { products: product._id } }
        );
      }
    }

    console.log(`Inserted ${inserted.length} dummy products with Unsplash images.`);
    process.exit(0);
  } catch (error) {
    console.error('Failed to seed dummy products:', error);
    process.exit(1);
  }
};

seedDummyProducts();
